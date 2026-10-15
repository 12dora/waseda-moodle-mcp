/**
 * What a course contributes to the timetable and where it comes from (contract §15.1): the user's own times, the
 * public syllabus, or the attendance sessions seen in Moodle. Each source says when its slots apply (`coverage`).
 */

import { isoJst } from '../../time';
import type { Course, InferredSchedule, ScheduleOverride, TimetableClass, TimetableSource } from '../../types';
import type { SyllabusInfo } from '../syllabus';
import {
  type AcademicCalendar,
  academicYearOf,
  addDays,
  calendarFor,
  insideAnyTerm,
  TERM_JOIN,
  termCovers,
  termEndOn,
} from './calendar';
import { periodsLabel, slotClock } from './periods';

/** WBS (57) and CJL (92) end their classes a week before the university calendar. */
const SHORT_CALENDAR_SCHOOLS = new Set(['57', '92']);

type CourseRef = Pick<Course, 'id' | 'name' | 'url'>;

interface EntrySlot {
  weekday: number; // Mon = 1 ... Sun = 7
  periodFrom: number;
  periodTo: number;
  night: boolean;
  classroom: string | null;
  campus: string | null;
}

/** When the slots apply: a syllabus term of one academic year, or an inclusive date window (null = open). */
type Coverage =
  | { kind: 'term'; term: string | null; year: number; short: boolean }
  | { kind: 'window'; from: string | null; to: string | null };

export interface TimetableEntry {
  course: CourseRef;
  source: TimetableSource;
  slots: EntrySlot[];
  coverage: Coverage;
  /** Shown in the separate list: full on-demand, or no fixed weekly time (intensive, "other"). */
  listing: 'on-demand' | 'no-fixed-time' | null;
  /** Hybrid: on-demand (or intensive) and also meets weekly in the grid. */
  alsoInClass: boolean;
}

/** Sessions created week by week: a last one this recent says nothing about when the classes end. */
const RECENT_SESSION_DAYS = 14;

const isIntensive = (term: string | null) => term?.split(TERM_JOIN).includes('集中') === true;
/** A term with weekly classes (集中 alone has none). */
const hasWeeklyTerm = (term: string | null) => term?.split(TERM_JOIN).some((t) => t !== '集中') === true;

const jstDate = (iso: string | null) => (iso === null ? null : iso.slice(0, 10));

const courseWindow = (course: Course): Coverage => ({
  kind: 'window',
  from: jstDate(course.start),
  to: jstDate(course.end),
});

const termCoverage = (info: SyllabusInfo): Coverage => ({
  kind: 'term',
  term: info.term,
  year: info.year,
  short: SHORT_CALENDAR_SCHOOLS.has(info.pKey.slice(-2)),
});

// ------------------------------------------------------------------ builders

const OVERRIDE_LISTING: Record<ScheduleOverride['mode'], TimetableEntry['listing']> = {
  slots: null,
  'on-demand': 'on-demand',
  none: 'no-fixed-time',
};

/**
 * The user's own times; `none` is listed as "no weekly class" so the user can still find and change it. They apply
 * in the syllabus term of the course when that is known (the short WBS / CJL calendars included), else in its
 * Moodle window.
 */
export function overrideEntry(course: Course, override: ScheduleOverride, info: SyllabusInfo | null): TimetableEntry {
  const slots = override.mode === 'slots' ? override.slots.map((s): EntrySlot => ({ ...s, campus: null })) : [];
  const hybrid = override.mode === 'slots' && override.alsoOnDemand;
  return {
    course,
    source: 'user',
    slots,
    coverage: info && hasWeeklyTerm(info.term) ? termCoverage(info) : courseWindow(course),
    listing: hybrid ? 'on-demand' : OVERRIDE_LISTING[override.mode],
    alsoInClass: hybrid,
  };
}

const showsSomething = (info: SyllabusInfo): boolean =>
  (info.slots ?? []).length > 0 || info.onDemand === true || isIntensive(info.term);

/** A syllabus gives something to show (weekly slots, on-demand, intensive) and all of it was understood. */
export const hasUsableSchedule = (info: SyllabusInfo): boolean => !info.scheduleUnparsed && showsSomething(info);

/** Part of the syllabus time was understood and part was not: what is known can be shown, but the course is unsure. */
export const hasPartialSchedule = (info: SyllabusInfo): boolean =>
  info.scheduleUnparsed === true && showsSomething(info);

export function syllabusEntry(course: CourseRef, info: SyllabusInfo): TimetableEntry {
  const slots = info.slots ?? [];
  const intensive = isIntensive(info.term);
  const pure = info.term === '集中';
  let listing: TimetableEntry['listing'] = null;
  if (info.onDemand) listing = 'on-demand';
  else if (intensive || slots.length === 0) listing = 'no-fixed-time';
  return {
    course,
    source: 'syllabus',
    slots,
    coverage: termCoverage(info),
    listing,
    alsoInClass: slots.length > 0 && !pure,
  };
}

/**
 * Last day the attendance-session slots apply: the last session seen, or, when that was in the past two weeks
 * (sessions are created week by week), the end of the term it was in (the Moodle end of the course, if sooner).
 */
function sessionsEnd(course: Course, lastDate: string | null, now: number): string | null {
  if (lastDate === null) return null;
  const today = isoJst(now).slice(0, 10);
  if (lastDate > today || lastDate < addDays(today, -RECENT_SESSION_DAYS)) return lastDate;
  const ends = [termEndOn(calendarFor(lastDate), lastDate), jstDate(course.end)].filter((d): d is string => d !== null);
  const end = ends.sort()[0];
  return end !== undefined && end > lastDate ? end : lastDate;
}

/** Attendance-session slots of a course; null when Moodle showed no weekly meeting. `now` is in ms. */
export function inferredEntry(course: Course, inferred: InferredSchedule, now: number): TimetableEntry | null {
  if (inferred.slots.length === 0) return null;
  return {
    course,
    source: 'moodle',
    slots: inferred.slots.map((s): EntrySlot => ({ ...s, campus: null })),
    coverage: { kind: 'window', from: inferred.firstDate, to: sessionsEnd(course, inferred.lastDate, now) },
    listing: null,
    alsoInClass: false,
  };
}

// ------------------------------------------------------------------ queries

type DateWindow = { from: string | null; to: string | null };

/** Inside the window and in an academic year it touches: an open end (no Moodle end date) lasts one year only. */
function inWindow(c: DateWindow, iso: string): boolean {
  if ((c.from !== null && iso < c.from) || (c.to !== null && iso > c.to)) return false;
  const first = c.from === null ? null : academicYearOf(c.from);
  const last = c.to === null ? first : academicYearOf(c.to);
  const year = academicYearOf(iso);
  return (first === null || year >= first) && (last === null || year <= last);
}

/**
 * Whether the entry's weekly slots apply on `iso`. A syllabus slot (or a user time on a course with a known term)
 * belongs to its own academic year and term; other user and Moodle times apply inside their window while a term runs.
 */
export function covers(entry: TimetableEntry, iso: string, calendar: AcademicCalendar): boolean {
  const c = entry.coverage;
  if (c.kind === 'term') return c.year === calendar.year && termCovers(calendar, { iso, term: c.term, short: c.short });
  return insideAnyTerm(calendar, iso) && inWindow(c, iso);
}

/** The term to show next to a listed course (Moodle times, and user times without a known term, have none). */
export const termOf = (entry: TimetableEntry): string | null =>
  entry.coverage.kind === 'term' ? entry.coverage.term : null;

/**
 * Whether the course belongs in the separate list for `dates`: its academic year is one of the dates', and its term
 * overlaps them (intensive courses have no weekly term, so the year decides). A window (Moodle times, user times
 * without a known term) is checked as it is.
 */
export function listedIn(entry: TimetableEntry, dates: string[]): boolean {
  if (entry.listing === null) return false;
  const c = entry.coverage;
  if (c.kind === 'window') return dates.some((d) => inWindow(c, d));
  if (!dates.some((d) => calendarFor(d).year === c.year)) return false;
  return isIntensive(c.term) || dates.some((d) => covers(entry, d, calendarFor(d)));
}

/** The entry's classes on a weekday (the date's own, or the one a 振替 day follows). */
export function classesFor(entry: TimetableEntry, weekday: number): TimetableClass[] {
  return entry.slots.flatMap((slot): TimetableClass[] => {
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
        source: entry.source,
      },
    ];
  });
}
