/**
 * Timetable: each day's classes of the user's courses with real start/end times (contract §14).
 * Slots come from the public syllabus (services/syllabus.ts, cached globally), the clock from periods.ts, the dates
 * from calendar.ts (term windows, held holidays, no-class days, 振替).
 */

import type { ServiceContext } from '../../context';
import { InvalidInput } from '../../errors';
import { isoJst, nowMs } from '../../time';
import type {
  Course,
  Timetable,
  TimetableClass,
  TimetableCourseRef,
  TimetableDay,
  TimetableUnscheduled,
} from '../../types';
import { resolveScope } from '../scope';
import { lookupSeenCourses, type SyllabusInfo } from '../syllabus';
import { type AcademicCalendar, addDays, calendarFor, dayStatus, isIsoDate, termCovers, weekdayOf } from './calendar';
import { EVENING_TIMES, periodsLabel, STANDARD_TIMES, slotClock } from './periods';

const MAX_DAYS = 14;
/** WBS (57) and CJL (92) end their classes a week before the university calendar. */
const SHORT_CALENDAR_SCHOOLS = new Set(['57', '92']);

/** A course the user attends together with its syllabus schedule. */
export interface TimetableEntry {
  course: Pick<Course, 'id' | 'name' | 'url'>;
  info: SyllabusInfo;
}

const schoolOf = (info: SyllabusInfo) => info.pKey.slice(-2);
const isShort = (info: SyllabusInfo) => SHORT_CALENDAR_SCHOOLS.has(schoolOf(info));

function classesFor(entry: TimetableEntry, weekday: number): TimetableClass[] {
  return (entry.info.slots ?? []).flatMap((slot): TimetableClass[] => {
    const clock = slot.weekday === weekday ? slotClock(slot) : null;
    if (!clock) return [];
    return [
      {
        courseId: entry.course.id,
        courseName: entry.course.name,
        ...clock,
        periods: periodsLabel(slot),
        periodFrom: slot.periodFrom,
        periodTo: slot.periodTo,
        night: slot.night,
        classroom: slot.classroom,
        campus: slot.campus,
        url: entry.course.url,
      },
    ];
  });
}

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
        .filter((e) => termCovers(calendar, { iso: date, term: e.info.term, short: isShort(e.info) }))
        .flatMap((e) => classesFor(e, status.weekday))
        .sort((a, b) => a.start.localeCompare(b.start) || a.courseName.localeCompare(b.courseName));
  return { date, weekday: weekdayOf(date), note: status.note, classes };
}

// ------------------------------------------------------------------ request

function resolveStart(date: string | undefined): string {
  const today = isoJst(nowMs()).slice(0, 10);
  if (date === undefined || date === 'today') return today;
  if (date === 'tomorrow') return addDays(today, 1);
  if (!isIsoDate(date)) throw new InvalidInput("date must be 'today', 'tomorrow' or YYYY-MM-DD.");
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

/** Full on-demand and slot-less (intensive, "other") courses, kept only while their term overlaps the range. */
function unscheduledIn(entries: TimetableEntry[], dates: string[]): TimetableUnscheduled[] {
  return entries.flatMap((e): TimetableUnscheduled[] => {
    const hasSlots = (e.info.slots ?? []).length > 0;
    if (!e.info.onDemand && hasSlots) return [];
    const intensive = e.info.term === '集中';
    const active =
      intensive || dates.some((d) => termCovers(calendarFor(d), { iso: d, term: e.info.term, short: isShort(e.info) }));
    if (!active) return [];
    return [{ ...refOf(e.course), term: e.info.term, kind: e.info.onDemand ? 'on-demand' : 'no-fixed-time' }];
  });
}

/**
 * The user's timetable for `days` days from `date` ('today' | 'tomorrow' | YYYY-MM-DD; default today, 1 day).
 * Scope = the user's courses. Uses the cached syllabus; courses not cached yet are fetched within the request's
 * 3-fetch syllabus budget (shared with the scope resolution), the rest are listed as unknown.
 */
export async function getTimetable(
  ctx: ServiceContext,
  opts: { date?: string; days?: number } = {},
): Promise<Timetable> {
  const from = resolveStart(opts.date);
  const count = resolveDays(opts.days);
  const scope = await resolveScope(ctx);
  const mine = scope.courses.filter((c) => c.mine && c.kind === 'class');
  const infos = await lookupSeenCourses(
    ctx,
    mine.map((c) => c.id),
  );
  const entries: TimetableEntry[] = [];
  const unknown: TimetableCourseRef[] = [];
  for (const course of mine) {
    const info = infos.get(course.id) ?? null;
    if (info) entries.push({ course, info });
    else unknown.push(refOf(course));
  }
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
