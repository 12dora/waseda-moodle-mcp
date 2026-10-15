/**
 * Keeps course snapshots current within a Moodle call budget:
 * missing → full fetch; older than 30 min → core_course_get_updates_since → full refetch only when content changed
 * (completion-only changes refresh just the flags). A snapshot fetched too long ago is refetched regardless, because
 * updates_since does not report section summaries / section names.
 */

import type { MoodleApi, ServiceContext } from '../../context';
import { BudgetExceeded, MoodleError, MoodleUnavailable } from '../../errors';
import { isoJst, nowMs } from '../../time';
import type { Course } from '../../types';
import { applyCompletion, COMPLETION_AREAS, COMPLETION_FN, type RawCompletion } from './completion';
import { buildSnapshot, type CourseSnapshot, parseSnapshot, REFETCH_AREAS, snapshotCmids } from './snapshot';
import { stampChanges } from './snapshot-diff';
import { CallBudget, type SweepStats } from './types';

const CONTENTS_FN = 'core_course_get_contents';
const UPDATES_FN = 'core_course_get_updates_since';
const FRESH_MS = 30 * 60_000;
const SINCE_SLACK_SEC = 300;
const HOUR_MS = 3_600_000;
/** A snapshot older than this (since its last full fetch) is refetched; the cron uses the short limit, so it normally goes first. */
export const CRON_MAX_AGE_MS = 24 * HOUR_MS;
const INTERACTIVE_MAX_AGE_MS = 36 * HOUR_MS;
/** Raw courses bigger than this are CPU-heavy to parse (Workers Free: 10 ms). */
const LARGE_COURSE_BYTES = 100_000;

export interface RefreshOptions {
  maxCalls: number; // Moodle calls this refresh may spend
  maxFull: number; // full core_course_get_contents fetches
  maxLarge?: number; // of those, fetches of courses known to be large (default: maxFull)
  maxAgeMs?: number; // refetch snapshots whose last full fetch is older (default 36 h)
  /** Remember `courses` as the interactive scope for the cron (default true; false for the cron, one-course calls). */
  rememberScope?: boolean;
  /** Courses without a snapshot (size unknown) take a large-fetch slot like known large ones (the cron's guard). */
  unknownIsLarge?: boolean;
  /** Kept current while refreshing, so a caller still knows the large fetches done when the refresh throws. */
  tally?: { large: number };
}

export interface RefreshResult {
  snapshots: Map<number, CourseSnapshot>; // every target course that has a snapshot (possibly stale)
  stats: SweepStats;
  refreshed: number; // full fetches done
  large: number; // of those, fetches of large courses (known beforehand, unknown size when so configured, or measured)
}

interface Entry {
  course: Course;
  snap: CourseSnapshot | null;
  checkedAt: number;
  fetchedAt: number;
  aged: boolean; // last full fetch older than the age limit
}

type Updates = Map<number, string[]>;
interface Escalation {
  entry: Entry;
  updates: Updates;
}

interface RawUpdates {
  instances?: Array<{ id?: number; updates?: Array<{ name?: string }> | null }> | null;
}

const isSoft = (e: unknown) =>
  e instanceof MoodleError || e instanceof MoodleUnavailable || e instanceof BudgetExceeded;

/** Update names per cmid, and whether any of them means the snapshot is outdated. */
function readUpdates(
  res: RawUpdates | null,
  snap: CourseSnapshot,
): { updates: Updates; outdated: boolean; completion: boolean } {
  const known = snapshotCmids(snap);
  const updates: Updates = new Map();
  let outdated = false;
  let completion = false;
  for (const inst of res?.instances ?? []) {
    const names = (inst.updates ?? []).flatMap((u) => (u.name ? [u.name] : []));
    if (!inst.id || names.length === 0) continue;
    updates.set(inst.id, names);
    if (!known.has(inst.id) || names.some((n) => REFETCH_AREAS.has(n))) outdated = true;
    if (names.some((n) => COMPLETION_AREAS.has(n))) completion = true;
  }
  return { updates, outdated, completion };
}

class Refresher {
  refreshed = 0;
  private fullLeft: number;
  private largeLeft: number;
  private readonly budget: CallBudget;
  private readonly unknownIsLarge: boolean;
  readonly tally: { large: number };

  constructor(
    private readonly ctx: ServiceContext,
    private readonly api: MoodleApi,
    private readonly now: number,
    opts: RefreshOptions,
  ) {
    this.fullLeft = opts.maxFull;
    this.largeLeft = opts.maxLarge ?? opts.maxFull;
    this.budget = new CallBudget(opts.maxCalls);
    this.unknownIsLarge = opts.unknownIsLarge ?? false;
    this.tally = opts.tally ?? { large: 0 };
  }

  private async persist(entry: Entry, snap: CourseSnapshot, fetchedAt: number): Promise<void> {
    await this.ctx.store.putCourseSnapshot({
      userId: this.ctx.user.id,
      courseId: entry.course.id,
      json: JSON.stringify(snap),
      fetchedAt,
      checkedAt: this.now,
    });
    entry.snap = snap;
    entry.checkedAt = this.now;
  }

  private takeLarge(): void {
    this.largeLeft--;
    this.tally.large++;
  }

  /**
   * Claims a full fetch and, for a course known to be large (or, when `unknownIsLarge`, never fetched), one of the few
   * large-fetch slots; nothing is consumed unless the fetch can really happen. null when out of fetches, large slots
   * or calls.
   */
  private reserve(entry: Entry): { large: boolean } | null {
    const large = entry.snap ? (entry.snap.z ?? 0) > LARGE_COURSE_BYTES : this.unknownIsLarge;
    if (this.fullLeft <= 0 || (large && this.largeLeft <= 0) || !this.budget.take()) return null;
    this.fullLeft--;
    if (large) this.takeLarge();
    return { large };
  }

  /** Full fetch + store. false when out of budget or Moodle failed for this course. */
  async fetchFull(entry: Entry, updates: Updates = new Map()): Promise<boolean> {
    const slot = this.reserve(entry);
    return slot ? this.download(entry, { large: slot.large, updates }) : false;
  }

  /** An aged course is refetched when it can be; otherwise it still gets the cheap change check. */
  async refetchOrCheck(entry: Entry): Promise<Escalation | null> {
    const slot = this.reserve(entry);
    if (!slot) return this.check(entry);
    await this.download(entry, { large: slot.large, updates: new Map() });
    return null;
  }

  private async download(entry: Entry, opts: { large: boolean; updates: Updates }): Promise<boolean> {
    try {
      const raw = await this.api.call(CONTENTS_FN, { courseid: entry.course.id });
      const fresh = buildSnapshot(raw, { baseUrl: this.api.baseUrl, now: this.now });
      // a course whose size was not known beforehand still counts against the large budget once it proves large
      if (!opts.large && (fresh.z ?? 0) > LARGE_COURSE_BYTES) this.takeLarge();
      const stamped = stampChanges(fresh, entry.snap, { now: this.now, updates: opts.updates });
      await this.persist(entry, stamped, this.now);
      entry.fetchedAt = this.now;
      entry.aged = false;
      this.refreshed++;
      return true;
    } catch (e) {
      if (isSoft(e)) return false;
      throw e;
    }
  }

  /** A check must leave a call for every refetch it might trigger. */
  private canCheck(): boolean {
    return this.budget.remaining - 1 >= this.fullLeft;
  }

  private async syncCompletion(entry: Entry, snap: CourseSnapshot): Promise<void> {
    const res = await this.api.call<RawCompletion>(COMPLETION_FN, {
      courseid: entry.course.id,
      userid: this.api.moodleUserId,
    });
    applyCompletion(snap, res);
    await this.persist(entry, snap, entry.fetchedAt);
  }

  /** Cheap change check; touches the snapshot when nothing relevant changed, else asks for a refetch. */
  async check(entry: Entry): Promise<Escalation | null> {
    if (!entry.snap || !this.canCheck() || !this.budget.take()) return null;
    try {
      const since = Math.floor(entry.checkedAt / 1000) - SINCE_SLACK_SEC;
      const res = await this.api.call<RawUpdates>(UPDATES_FN, { courseid: entry.course.id, since });
      const { updates, outdated, completion } = readUpdates(res, entry.snap);
      if (outdated) return { entry, updates };
      if (completion) {
        // Without a call left the flags stay stale and the snapshot stays unchecked.
        if (this.canCheck() && this.budget.take()) await this.syncCompletion(entry, entry.snap);
        return null;
      }
      await this.ctx.store.touchCourseSnapshot(this.ctx.user.id, entry.course.id, this.now);
      entry.checkedAt = this.now;
      return null;
    } catch (e) {
      // updates_since unavailable for this course: fall back to a plain refetch.
      if (e instanceof MoodleError) return { entry, updates: new Map() };
      if (isSoft(e)) return null;
      throw e;
    }
  }
}

async function loadEntries(
  ctx: ServiceContext,
  courses: readonly Course[],
  limit: { now: number; maxAgeMs: number },
): Promise<Entry[]> {
  const rows = new Map((await ctx.store.getCourseSnapshots(ctx.user.id)).map((r) => [r.courseId, r]));
  return courses.map((course) => {
    const row = rows.get(course.id);
    const snap = row ? parseSnapshot(row.json) : null;
    const fetchedAt = snap && row ? row.fetchedAt : 0;
    return {
      course,
      snap,
      checkedAt: snap && row ? row.checkedAt : 0,
      fetchedAt,
      aged: snap !== null && limit.now - fetchedAt > limit.maxAgeMs,
    };
  });
}

const isFresh = (e: Entry, now: number) => e.snap !== null && !e.aged && now - e.checkedAt <= FRESH_MS;

function summarize(entries: readonly Entry[], now: number): Pick<RefreshResult, 'snapshots' | 'stats'> {
  const snapshots = new Map<number, CourseSnapshot>();
  let oldest: number | null = null;
  let checked = 0;
  for (const e of entries) {
    if (e.snap) snapshots.set(e.course.id, e.snap);
    if (!isFresh(e, now)) continue;
    checked++;
    oldest = oldest === null ? e.checkedAt : Math.min(oldest, e.checkedAt);
  }
  const stats: SweepStats = {
    checked,
    stale: entries.length - checked,
    checkedAt: oldest === null ? null : isoJst(oldest),
  };
  return { snapshots, stats };
}

const sameIds = (a: readonly number[] | undefined, b: readonly number[]) =>
  a !== undefined && a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The cron has no calendar signal and reads cached syllabus rows only, so it learns the scope an interactive call
 * resolved. Best effort, and written only when the list changed.
 */
async function rememberScope(ctx: ServiceContext, courses: readonly Course[]): Promise<void> {
  const ids = [...new Set(courses.map((c) => c.id))].sort((a, b) => a - b);
  if (sameIds(ctx.user.scopeCourseIds, ids)) return;
  try {
    await ctx.store.setScopeCourseIds(ctx.user.id, ids);
    ctx.user.scopeCourseIds = ids;
  } catch {
    console.error('scope remember failed');
  }
}

/**
 * Brings the snapshots of `courses` up to date as far as the budget allows (missing first, then oldest checked).
 * Never throws for a single failing course; NeedsReconnect still propagates.
 */
export async function refreshSnapshots(
  ctx: ServiceContext,
  courses: readonly Course[],
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const now = nowMs();
  if (opts.rememberScope ?? true) await rememberScope(ctx, courses);
  const entries = await loadEntries(ctx, courses, { now, maxAgeMs: opts.maxAgeMs ?? INTERACTIVE_MAX_AGE_MS });
  const stale = entries.filter((e) => !isFresh(e, now));
  if (stale.length === 0) return { ...summarize(entries, now), refreshed: 0, large: 0 };

  const r = new Refresher(ctx, await ctx.moodle(), now, opts);
  const missing = stale.filter((e) => !e.snap);
  const aged = stale.filter((e) => e.snap && e.aged);
  const existing = stale.filter((e) => e.snap && !e.aged).sort((a, b) => a.checkedAt - b.checkedAt);
  // Reservations happen synchronously in this order: new courses, then aged ones, get their fetch before any cheap check.
  const [, agedChecks, checks] = await Promise.all([
    Promise.all(missing.map((e) => r.fetchFull(e))),
    Promise.all(aged.map((e) => r.refetchOrCheck(e))),
    Promise.all(existing.map((e) => r.check(e))),
  ]);
  await Promise.all([...agedChecks, ...checks].flatMap((c) => (c ? [r.fetchFull(c.entry, c.updates)] : [])));
  return { ...summarize(entries, now), refreshed: r.refreshed, large: r.tally.large };
}
