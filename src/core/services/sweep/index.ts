/** Course-content sweep: undated activities, deadlines in course text / announcements, "what's new", snapshot search. */

import type { ServiceContext } from '../../context';
import { InvalidInput, NotFound } from '../../errors';
import { nowMs } from '../../time';
import type { Course, CourseUpdate, DueItem, SearchHit } from '../../types';
import { type CourseScope, resolveScope } from '../scope';
import { ANNOUNCE_CALLS, announcementItems } from './announcements';
import { dropCoveredText } from './dedupe';
import {
  inTextWindow,
  pendingActivityItems,
  type TextWindow,
  taskModules,
  textDeadlineItems,
} from './extract-activities';
import { refreshSnapshots } from './refresh';
import { parseQuery, type ScoredHit, searchSnapshot } from './search';
import type { CourseSnapshot } from './snapshot';
import { attachTaskMentions } from './task-mentions';
import type { SweepStats } from './types';
import { courseUpdates } from './updates';

export type { SweepStats } from './types';

const MAX_CALLS = 12; // Moodle calls per request
const MAX_FULL = 3; // full course refetches per request
const MAX_LARGE = 1; // of those, courses whose raw JSON is large (> 100 KB): CPU limit
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

interface Extracted {
  pending: DueItem[];
  mentioned: DueItem[];
  taskCmids: Set<number>;
}

function extractAll(
  targets: readonly Course[],
  snapshots: ReadonlyMap<number, CourseSnapshot>,
  opts: { now: number; fromMs: number; toMs: number },
): Extracted {
  const out: Extracted = { pending: [], mentioned: [], taskCmids: new Set() };
  for (const course of targets) {
    const snap = snapshots.get(course.id);
    if (!snap) continue;
    out.pending.push(...pendingActivityItems(course, snap, opts));
    out.mentioned.push(...textDeadlineItems(course, snap, opts));
    for (const cmid of taskModules(snap).keys()) out.taskCmids.add(cmid);
  }
  return out;
}

/** Announcement mentions inside the window (course-text mentions are already filtered, before their cap). */
function timely(items: readonly DueItem[], win: TextWindow): DueItem[] {
  return items.filter((i) => inTextWindow(i.dueAt ? Date.parse(i.dueAt) : Number.NaN, win));
}

/**
 * Sweep results for the scope courses that the calendar did not already list:
 * pending activities without a deadline, and deadlines mentioned in course text / recent announcements.
 * Text items are limited to `window`; ≤ 12 Moodle calls and ≤ 3 full refetches.
 * `calendar` is the given calendar list, where an undated item may have received the date its own module text mentions.
 * `rememberScope: false` (a one-course call) keeps the remembered cron scope untouched.
 * `cachedOnly` spends no Moodle call: the stored snapshots are used as they are (the cron keeps them fresh) and
 * announcements are skipped; the calendar feed builds this way so a poll never refreshes course content.
 */
export async function collectSweepItems(
  ctx: ServiceContext,
  scope: CourseScope,
  calendar: readonly DueItem[],
  window: { fromMs: number; toMs: number; rememberScope?: boolean; cachedOnly?: boolean },
): Promise<{ items: DueItem[]; calendar: DueItem[]; stats: SweepStats }> {
  const targets = inScope(scope);
  if (targets.length === 0) return { items: [], calendar: [...calendar], stats: NO_STATS };
  const now = nowMs();
  const api = await ctx.moodle();
  const { rememberScope, cachedOnly, ...span } = window;
  const [refresh, announced] = await Promise.all([
    refreshSnapshots(ctx, targets, {
      maxCalls: cachedOnly ? 0 : MAX_CALLS - ANNOUNCE_CALLS,
      maxFull: MAX_FULL,
      maxLarge: MAX_LARGE,
      rememberScope: cachedOnly ? false : rememberScope,
    }),
    announcementItems(api, targets, { now, maxCalls: cachedOnly ? 0 : ANNOUNCE_CALLS }),
  ]);
  const win = { now, ...span };
  const found = extractAll(targets, refresh.snapshots, win);
  const calendarCmids = new Set(calendar.flatMap((i) => (i.cmid === null ? [] : [i.cmid])));
  const attached = attachTaskMentions({
    mentions: [...found.mentioned, ...timely(announced, win)],
    calendar,
    activities: found.pending.filter((i) => i.cmid === null || !calendarCmids.has(i.cmid)),
    taskCmids: found.taskCmids,
  });
  const texts = [...attached.standalone, ...dropCoveredText(attached.rest, calendar)];
  return { items: [...attached.activities, ...texts], calendar: attached.calendar, stats: refresh.stats };
}

/** New / changed modules of the scope courses (or one course) within the last `sinceDays` (default 7). */
export async function getCourseUpdates(
  ctx: ServiceContext,
  opts: { sinceDays?: number; courseId?: number } = {},
): Promise<{ updates: CourseUpdate[]; stats: SweepStats }> {
  const targets = pickCourses(await resolveScope(ctx), opts.courseId);
  const sinceMs = nowMs() - clamp(opts.sinceDays, UPDATES_DEFAULT_DAYS, UPDATES_MAX_DAYS) * DAY_MS;
  const { snapshots, stats } = await refreshSnapshots(ctx, targets, {
    maxCalls: MAX_CALLS,
    maxFull: MAX_FULL,
    maxLarge: MAX_LARGE,
    rememberScope: opts.courseId === undefined, // a one-course call must not replace the remembered scope
  });
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
  const { snapshots, refreshed } = await refreshSnapshots(ctx, targets, {
    maxCalls: MAX_CALLS,
    maxFull: MAX_FULL,
    maxLarge: MAX_LARGE,
    rememberScope: opts.courseId === undefined,
  });
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
