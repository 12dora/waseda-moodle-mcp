/** Course-content sweep: undated activities, deadlines in course text / announcements, "what's new", snapshot search. */

import type { ServiceContext } from '../../context';
import { InvalidInput, NotFound } from '../../errors';
import { nowMs } from '../../time';
import type { Course, CourseUpdate, DueItem, SearchHit } from '../../types';
import { type CourseScope, resolveScope } from '../scope';
import { announcementItems } from './announcements';
import { dropCoveredText } from './dedupe';
import { pendingActivityItems, textDeadlineItems } from './extract-activities';
import { refreshSnapshots } from './refresh';
import { parseQuery, type ScoredHit, searchSnapshot } from './search';
import type { SweepStats } from './types';
import { courseUpdates } from './updates';

export type { SweepStats } from './types';

const MAX_CALLS = 12; // Moodle calls per request
const MAX_FULL = 3; // full course refetches per request
const ANNOUNCE_CALLS = 5; // share of MAX_CALLS reserved for announcements (1 forum list + up to 4 forums)
const DAY_MS = 86_400_000;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const UPDATES_DEFAULT_DAYS = 7;
const UPDATES_MAX_DAYS = 60;

const NO_STATS: SweepStats = { checked: 0, stale: 0, checkedAt: null };

const inScope = (scope: CourseScope): Course[] => scope.courses.filter((c) => scope.mine.has(c.id));

function pickCourses(scope: CourseScope, courseId: number | undefined): Course[] {
  if (courseId === undefined) return inScope(scope);
  const course = scope.courses.find((c) => c.id === courseId);
  if (!course) throw new NotFound('That course is not among your enrolled courses.');
  return [course];
}

function clamp(v: number | undefined, dflt: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(1, Math.trunc(v))) : dflt;
}

/**
 * Sweep results for the scope courses that the calendar did not already list:
 * pending activities without a deadline, and deadlines mentioned in course text / recent announcements.
 * Text items are limited to `window`; ≤ 12 Moodle calls and ≤ 3 full refetches.
 */
export async function collectSweepItems(
  ctx: ServiceContext,
  scope: CourseScope,
  calendar: readonly DueItem[],
  window: { fromMs: number; toMs: number },
): Promise<{ items: DueItem[]; stats: SweepStats }> {
  const targets = inScope(scope);
  if (targets.length === 0) return { items: [], stats: NO_STATS };
  const now = nowMs();
  const api = await ctx.moodle();
  const [refresh, announced] = await Promise.all([
    refreshSnapshots(ctx, targets, { maxCalls: MAX_CALLS - ANNOUNCE_CALLS, maxFull: MAX_FULL }),
    announcementItems(api, targets, { now, maxCalls: ANNOUNCE_CALLS }),
  ]);
  const pending: DueItem[] = [];
  const mentioned: DueItem[] = [];
  for (const course of targets) {
    const snap = refresh.snapshots.get(course.id);
    if (!snap) continue;
    pending.push(...pendingActivityItems(course, snap, { now, toMs: window.toMs }));
    mentioned.push(...textDeadlineItems(course, snap, now));
  }
  mentioned.push(...announced);
  const inWindow = mentioned.filter((i) => {
    const ms = i.dueAt ? Date.parse(i.dueAt) : Number.NaN;
    return ms >= window.fromMs && ms <= window.toMs;
  });
  const texts = dropCoveredText(inWindow, calendar);
  const taken = new Set([...calendar, ...texts].flatMap((i) => (i.cmid === null ? [] : [i.cmid])));
  const activities = pending.filter((i) => i.cmid === null || !taken.has(i.cmid));
  return { items: [...activities, ...texts], stats: refresh.stats };
}

/** New / changed modules of the scope courses (or one course) within the last `sinceDays` (default 7). */
export async function getCourseUpdates(
  ctx: ServiceContext,
  opts: { sinceDays?: number; courseId?: number } = {},
): Promise<{ updates: CourseUpdate[]; stats: SweepStats }> {
  const targets = pickCourses(await resolveScope(ctx), opts.courseId);
  const sinceMs = nowMs() - clamp(opts.sinceDays, UPDATES_DEFAULT_DAYS, UPDATES_MAX_DAYS) * DAY_MS;
  const { snapshots, stats } = await refreshSnapshots(ctx, targets, { maxCalls: MAX_CALLS, maxFull: MAX_FULL });
  const updates = targets.flatMap((c) => {
    const snap = snapshots.get(c.id);
    return snap ? courseUpdates(c, snap, sinceMs) : [];
  });
  updates.sort((a, b) => b.at.localeCompare(a.at));
  return { updates, stats };
}

/** Search module / file / section names in the snapshots of the scope courses (or `courseId`). */
export async function searchSnapshots(
  ctx: ServiceContext,
  scope: CourseScope,
  query: string,
  opts: { courseId?: number; limit?: number } = {},
): Promise<{ hits: SearchHit[]; searchedCourses: number; refreshed: number; skipped: number }> {
  const terms = parseQuery(query);
  if (terms.length === 0) throw new InvalidInput('The search query is empty.');
  const limit = clamp(opts.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
  const targets = pickCourses(scope, opts.courseId);
  const { snapshots, refreshed } = await refreshSnapshots(ctx, targets, { maxCalls: MAX_CALLS, maxFull: MAX_FULL });
  const scored: ScoredHit[] = [];
  for (const course of targets) {
    const snap = snapshots.get(course.id);
    if (snap) scored.push(...searchSnapshot(snap, course, terms));
  }
  scored.sort((a, b) => b.score - a.score); // stable: keeps course/section order within a score
  return {
    hits: scored.slice(0, limit).map((s) => s.hit),
    searchedCourses: snapshots.size,
    refreshed,
    skipped: targets.length - snapshots.size,
  };
}

/** Worker cron: bring the scope snapshots of one user up to date (≤ `maxRefresh` full refetches). */
export async function sweepForCron(ctx: ServiceContext, opts: { maxRefresh?: number } = {}): Promise<SweepStats> {
  const targets = inScope(await resolveScope(ctx));
  if (targets.length === 0) return NO_STATS;
  const { stats } = await refreshSnapshots(ctx, targets, { maxCalls: MAX_CALLS, maxFull: opts.maxRefresh ?? MAX_FULL });
  return stats;
}
