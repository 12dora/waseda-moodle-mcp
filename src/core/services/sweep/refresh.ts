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
}

export interface RefreshResult {
  snapshots: Map<number, CourseSnapshot>; // every target course that has a snapshot (possibly stale)
  stats: SweepStats;
  refreshed: number; // full fetches done
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

  constructor(
    private readonly ctx: ServiceContext,
    private readonly api: MoodleApi,
    private readonly now: number,
    opts: RefreshOptions,
  ) {
    this.fullLeft = opts.maxFull;
    this.largeLeft = opts.maxLarge ?? opts.maxFull;
    this.budget = new CallBudget(opts.maxCalls);
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

  /** A course known to be large takes one of the few large-fetch slots of a request. */
  private takeLarge(entry: Entry): boolean {
    if ((entry.snap?.z ?? 0) <= LARGE_COURSE_BYTES) return true;
    if (this.largeLeft <= 0) return false;
    this.largeLeft--;
    return true;
  }

  /** Full fetch + store. false when out of budget or Moodle failed for this course. */
  async fetchFull(entry: Entry, updates: Updates = new Map()): Promise<boolean> {
    if (this.fullLeft <= 0 || !this.takeLarge(entry) || !this.budget.take()) return false;
    this.fullLeft--;
    try {
      const raw = await this.api.call(CONTENTS_FN, { courseid: entry.course.id });
      const fresh = buildSnapshot(raw, { baseUrl: this.api.baseUrl, now: this.now });
      await this.persist(entry, stampChanges(fresh, entry.snap, { now: this.now, updates }), this.now);
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

function summarize(entries: readonly Entry[], now: number, refreshed: number): RefreshResult {
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
  return { snapshots, stats, refreshed };
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
  const entries = await loadEntries(ctx, courses, { now, maxAgeMs: opts.maxAgeMs ?? INTERACTIVE_MAX_AGE_MS });
  const stale = entries.filter((e) => !isFresh(e, now));
  if (stale.length === 0) return summarize(entries, now, 0);

  const r = new Refresher(ctx, await ctx.moodle(), now, opts);
  const missing = stale.filter((e) => !e.snap);
  const aged = stale.filter((e) => e.snap && e.aged);
  const existing = stale.filter((e) => e.snap && !e.aged).sort((a, b) => a.checkedAt - b.checkedAt);
  // Reservations happen synchronously in this order: new courses, then aged ones, get their fetch before any cheap check.
  const [, , checks] = await Promise.all([
    Promise.all(missing.map((e) => r.fetchFull(e))),
    Promise.all(aged.map((e) => r.fetchFull(e))),
    Promise.all(existing.map((e) => r.check(e))),
  ]);
  await Promise.all(checks.flatMap((c) => (c ? [r.fetchFull(c.entry, c.updates)] : [])));
  return summarize(entries, now, r.refreshed);
}
