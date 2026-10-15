/**
 * Cache-first "My courses" aggregator for GET /api/courses/overview (contract §6.3).
 * One resolveScope; due items with a cached sweep; timetable from stored sources; grading and updates from D1 only.
 */

import type { ServiceContext } from '../context';
import { MoodleError, NeedsReconnect } from '../errors';
import { isoJst, nowMs } from '../time';
import type {
  Course,
  CourseOverview,
  CourseOverviewItem,
  CourseSchedule,
  CourseSlot,
  CourseUpdate,
  DueItem,
  GradingRow,
  SyllabusSummary,
} from '../types';
import { getDueItems } from './due';
import { countDue } from './due-groups';
import { resolveScope } from './scope';
import { loadStoredSnapshots } from './sweep/refresh';
import type { CourseSnapshot } from './sweep/snapshot';
import { courseUpdates } from './sweep/updates';
import {
  type CachedSyllabusStatus,
  getSyllabusDetails,
  readCachedSyllabusPages,
  type SyllabusStatus,
} from './syllabus-details';
import type { SyllabusPage } from './syllabus-page';
import type { TimetableEntry } from './timetable/entries';
import { slotClock } from './timetable/periods';
import { resolveCourses } from './timetable/sources';

const DUE_AHEAD_DAYS = 60;
const DUE_OVERDUE_DAYS = 30;
/** 150 cmids; callBatch chunks 40, so two status/module rounds stay a handful of subrequests. */
const DUE_SUBMISSION_CHECKS = 150;
const UPDATES_DAYS = 14;
const UPDATES_PER_COURSE = 10;
const DAY_MS = 86_400_000;

const EMPTY_SCHEDULE: CourseSchedule = {
  slots: [],
  listing: null,
  alsoInClass: false,
  source: null,
};

const SYLLABUS_STATUS: Record<SyllabusStatus, SyllabusSummary['status']> = {
  ok: 'found',
  'no-page': 'not-found',
  'not-a-class': 'not-found',
  disabled: 'not-found',
  unavailable: 'error',
};

function toSlot(slot: TimetableEntry['slots'][number]): CourseSlot {
  const clock = slotClock(slot);
  return {
    weekday: slot.weekday,
    periodFrom: slot.periodFrom,
    periodTo: slot.periodTo,
    start: clock === null ? null : clock.start,
    end: clock === null ? null : clock.end,
    classroom: slot.classroom,
    campus: slot.campus,
  };
}

function scheduleOf(entry: TimetableEntry): CourseSchedule {
  return {
    slots: entry.slots.map(toSlot),
    listing: entry.listing,
    alsoInClass: entry.alsoInClass,
    source: entry.source,
  };
}

function schedulesByCourse(entries: readonly TimetableEntry[]): Map<number, CourseSchedule> {
  return new Map(entries.map((e) => [e.course.id, scheduleOf(e)]));
}

function itemsByCourse(items: readonly DueItem[]): Map<number, DueItem[]> {
  const out = new Map<number, DueItem[]>();
  for (const it of items) {
    const list = out.get(it.courseId);
    if (list) list.push(it);
    else out.set(it.courseId, [it]);
  }
  return out;
}

function gradingOf(page: SyllabusPage | null): { grading: GradingRow[] | null; gradingText: string | null } {
  if (page === null) return { grading: null, gradingText: null };
  if (page.grading.length > 0) return { grading: page.grading, gradingText: null };
  return { grading: null, gradingText: page.gradingText || null };
}

function recentUpdates(course: Course, snap: CourseSnapshot | undefined, sinceMs: number): CourseUpdate[] {
  if (!snap) return [];
  const updates = courseUpdates(course, snap, sinceMs);
  updates.sort((a, b) => b.at.localeCompare(a.at));
  return updates.slice(0, UPDATES_PER_COURSE);
}

interface RowBits {
  items: DueItem[];
  schedule: CourseSchedule;
  url: string | null;
  page: SyllabusPage | null;
  syllabusStatus: CachedSyllabusStatus;
  snap: CourseSnapshot | undefined;
  sinceMs: number;
}

function overviewRow(course: Course, bits: RowBits): CourseOverviewItem {
  const { grading, gradingText } = gradingOf(bits.page);
  return {
    id: course.id,
    name: course.name,
    url: course.url,
    term: course.term,
    kind: course.kind,
    schedule: bits.schedule,
    syllabusUrl: bits.url,
    grading,
    gradingText,
    syllabusStatus: bits.syllabusStatus,
    counts: countDue(bits.items),
    items: bits.items,
    updates: recentUpdates(course, bits.snap, bits.sinceMs),
  };
}

function isDueAuthError(e: unknown): boolean {
  return e instanceof NeedsReconnect || (e instanceof MoodleError && e.errorcode === 'invalidtoken');
}

async function dueForOverview(ctx: ServiceContext): Promise<{ items: DueItem[]; dueError: boolean }> {
  try {
    const due = await getDueItems(ctx, {
      daysAhead: DUE_AHEAD_DAYS,
      overdueDays: DUE_OVERDUE_DAYS,
      sweep: 'cached',
      maxSubmissionChecks: DUE_SUBMISSION_CHECKS,
    });
    return { items: due.items, dueError: false };
  } catch (e) {
    if (isDueAuthError(e)) throw e;
    console.error('[waseda-moodle] course overview due list failed:', e instanceof Error ? e.name : typeof e);
    return { items: [], dueError: true };
  }
}

export async function getCourseOverview(ctx: ServiceContext): Promise<CourseOverview> {
  const scope = await resolveScope(ctx);
  const mine = scope.courses.filter((c) => c.mine);
  const classCourses = mine.filter((c) => c.kind === 'class');
  const [due, resolved, syllabi, stored] = await Promise.all([
    dueForOverview(ctx),
    resolveCourses(ctx, classCourses, { attendance: 'cached' }),
    readCachedSyllabusPages(
      ctx,
      mine.map((c) => c.id),
    ),
    loadStoredSnapshots(ctx, mine),
  ]);
  const schedules = schedulesByCourse(resolved.entries);
  const grouped = itemsByCourse(due.items);
  const sinceMs = nowMs() - UPDATES_DAYS * DAY_MS;
  return {
    generatedAt: isoJst(nowMs()),
    scopeMode: scope.mode,
    dueError: due.dueError,
    courses: mine.map((course) => {
      const cached = syllabi.get(course.id);
      return overviewRow(course, {
        items: grouped.get(course.id) ?? [],
        schedule: schedules.get(course.id) ?? EMPTY_SCHEDULE,
        url: cached?.url ?? null,
        page: cached?.page ?? null,
        syllabusStatus: cached?.status ?? 'unknown',
        snap: stored.snapshots.get(course.id),
        sinceMs,
      });
    }),
  };
}

export async function getSyllabusSummary(ctx: ServiceContext, courseId: number): Promise<SyllabusSummary> {
  const d = await getSyllabusDetails(ctx, courseId);
  const { grading, gradingText } = gradingOf(d.page);
  return {
    courseId: d.courseId,
    url: d.url,
    grading,
    gradingText,
    status: SYLLABUS_STATUS[d.status],
  };
}
