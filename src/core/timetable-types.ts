/** Timetable shapes shared by the service, the MCP renderer, the Worker API and the console. */

/** A class time the user set for a course. `none` = no weekly meeting (listed under "no weekly class"). */
export interface ScheduleOverride {
  mode: 'slots' | 'on-demand' | 'none';
  slots: { weekday: number; periodFrom: number; periodTo: number; classroom: string | null }[]; // [] unless 'slots'
}

export interface PeriodTime {
  period: number; // 1-7
  start: string; // 'HH:MM'
  end: string;
}

export interface TimetableClass {
  courseId: number;
  courseName: string;
  start: string; // 'HH:MM' JST
  end: string;
  periods: string; // 'P3' or 'P1–2'
  periodFrom: number;
  periodTo: number;
  night: boolean; // 夜間主 weekday evening clock
  classroom: string | null;
  campus: string | null;
  url: string; // Moodle course page
  source: TimetableSource;
}

/** Where a class time comes from: the public syllabus, the course's attendance sessions in Moodle, or the user. */
export type TimetableSource = 'syllabus' | 'moodle' | 'user';

/** Weekly meetings derived from the attendance sessions of a course in Moodle (per user, never in the global cache). */
export interface InferredSchedule {
  slots: { weekday: number; periodFrom: number; periodTo: number; night: boolean; classroom: string | null }[];
  firstDate: string | null; // JST 'YYYY-MM-DD' of the first attendance session seen
  lastDate: string | null;
  checkedAt: number; // ms
}

/** Why a day is special; the MCP renderer and the console each word it. */
export type DayNote =
  | { kind: 'closed'; name: string }
  | { kind: 'winter-break' }
  | { kind: 'term-break' }
  | { kind: 'held'; name: string }
  | { kind: 'swap'; weekday: number };

export interface TimetableDay {
  date: string; // 'YYYY-MM-DD' (JST)
  weekday: number; // Mon = 1 ... Sun = 7
  notes: DayNote[]; // empty on a normal day
  classes: TimetableClass[]; // sorted by start time
}

export interface TimetableCourseRef {
  courseId: number;
  courseName: string;
  url: string;
}

/** A course with no weekly meeting: full on-demand (also hybrids, which are in `days` too) or intensive / "other". */
export interface TimetableUnscheduled extends TimetableCourseRef {
  term: string | null;
  kind: 'on-demand' | 'no-fixed-time';
  alsoInClass: boolean; // hybrid: also has weekly meetings in `days`
}

/** A course whose class time is not known: no syllabus page, not fetched yet, lookup switched off, or not understood. */
export interface TimetableUnknown extends TimetableCourseRef {
  reason: 'not-found' | 'pending' | 'lookup-off' | 'unparsed';
}

export interface Timetable {
  from: string; // first date of `days`
  to: string; // last date
  days: TimetableDay[];
  onDemand: TimetableUnscheduled[];
  unknown: TimetableUnknown[];
  periodTimes: { standard: PeriodTime[]; evening: PeriodTime[] };
  scopeMode: 'mine' | 'auto';
  /** True when a requested date lies outside the published AY2026 calendar: holidays and term ends are estimated. */
  approximate: boolean;
}
