/**
 * Timetable: each day's classes of the user's courses with real start/end times (contract §14, §15).
 * Slots come from the user's own times, the public syllabus (services/syllabus.ts, cached globally) or the attendance
 * sessions seen in Moodle (sources.ts); the clock from periods.ts, the dates from calendar.ts (term windows, held
 * holidays, no-class days, 振替).
 */

import type { ServiceContext } from '../../context';
import { InvalidInput } from '../../errors';
import { isoJst, nowMs } from '../../time';
import type { Course, Timetable, TimetableCourseRef, TimetableDay, TimetableUnscheduled } from '../../types';
import { resolveScope } from '../scope';
import { type AcademicCalendar, addDays, calendarFor, dayStatus, isIsoDate, weekdayOf } from './calendar';
import { classesFor, covers, listedIn, type TimetableEntry, termOf } from './entries';
import { EVENING_TIMES, STANDARD_TIMES } from './periods';
import { resolveCourses } from './sources';

const MAX_DAYS = 14;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** Classes on one JST date ('YYYY-MM-DD'): term window, closed days, 振替 and held holidays all applied. */
export function classesOn(
  date: string,
  entries: TimetableEntry[],
  calendar: AcademicCalendar = calendarFor(date),
): TimetableDay {
  const status = dayStatus(calendar, date);
  const classes = status.closed
    ? []
    : entries
        .filter((e) => covers(e, date, calendar))
        .flatMap((e) => classesFor(e, status.weekday))
        .sort((a, b) => a.start.localeCompare(b.start) || a.courseName.localeCompare(b.courseName));
  return { date, weekday: weekdayOf(date), notes: status.notes, classes };
}

// ------------------------------------------------------------------ request

function resolveStart(date: string | undefined): string {
  const today = isoJst(nowMs()).slice(0, 10);
  if (date === undefined || date === 'today') return today;
  if (date === 'tomorrow') return addDays(today, 1);
  const year = Number(date.slice(0, 4));
  if (!isIsoDate(date) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new InvalidInput(`date must be 'today', 'tomorrow' or YYYY-MM-DD (years ${MIN_YEAR}-${MAX_YEAR}).`);
  }
  return date;
}

function resolveDays(days: number | undefined): number {
  if (days === undefined) return 1;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new InvalidInput(`days must be a whole number between 1 and ${MAX_DAYS}.`);
  }
  return days;
}

const refOf = (course: Pick<Course, 'id' | 'name' | 'url'>): TimetableCourseRef => ({
  courseId: course.id,
  courseName: course.name,
  url: course.url,
});

/** On-demand courses (hybrids too) and slot-less (intensive, "other") ones, kept while they belong to the range. */
function unscheduledIn(entries: TimetableEntry[], dates: string[]): TimetableUnscheduled[] {
  return entries.flatMap((e): TimetableUnscheduled[] => {
    if (e.listing === null || !listedIn(e, dates)) return [];
    return [{ ...refOf(e.course), term: termOf(e), kind: e.listing, alsoInClass: e.alsoInClass }];
  });
}

/** The scope's class courses resolved to timetable entries (one scope resolution, one syllabus / attendance pass). */
async function loadEntries(ctx: ServiceContext) {
  const scope = await resolveScope(ctx);
  const resolved = await resolveCourses(
    ctx,
    scope.courses.filter((c) => c.mine && c.kind === 'class'),
  );
  return { scope, ...resolved };
}

/**
 * The user's timetable for `days` days from `date` ('today' | 'tomorrow' | YYYY-MM-DD; default today, 1 day).
 * Scope = the user's courses (confirmed, or the automatic suggestion). Uses the cached syllabus; courses not cached
 * yet are fetched within the request's 3-fetch syllabus budget (shared with the scope resolution); what the syllabus
 * cannot place is looked up once in the Moodle attendance calendar, the rest is listed as unknown.
 */
export async function getTimetable(
  ctx: ServiceContext,
  opts: { date?: string; days?: number } = {},
): Promise<Timetable> {
  const from = resolveStart(opts.date);
  const count = resolveDays(opts.days);
  const { scope, entries, unknown } = await loadEntries(ctx);
  const dates = Array.from({ length: count }, (_, i) => addDays(from, i));
  return {
    from,
    to: addDays(from, count - 1),
    days: dates.map((d) => classesOn(d, entries)),
    onDemand: unscheduledIn(entries, dates),
    unknown,
    periodTimes: { standard: [...STANDARD_TIMES], evening: [...EVENING_TIMES] },
    scopeMode: scope.mode,
    approximate: dates.some((d) => !calendarFor(d).official),
  };
}

/**
 * The classes of each of `dates` (YYYY-MM-DD, any number and spread), resolving the courses once. For callers that
 * need a longer range than getTimetable's 14 days (the calendar feed); dates are not validated.
 */
export async function getTimetableDays(ctx: ServiceContext, dates: readonly string[]): Promise<TimetableDay[]> {
  const { entries } = await loadEntries(ctx);
  return dates.map((d) => classesOn(d, entries));
}
