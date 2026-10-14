/**
 * Academic calendar: which dates have classes and which term windows apply (r6-report §3).
 * AY2026 is the published calendar (教務部 + WBS 研究科暦 + CJL, state of 2026-10). Other years use the same month rules
 * without any holiday knowledge, flagged `official: false`.
 */

type DateRange = readonly [from: string, to: string]; // inclusive 'YYYY-MM-DD'

export interface AcademicCalendar {
  year: number;
  official: boolean;
  /** Class windows per term, university-wide. */
  terms: Record<string, DateRange[]>;
  /** Earlier class end of WBS / CJL (春学期, 夏Q, 秋学期, 冬Q, 通年); other terms as in `terms`. */
  shortTerms: Record<string, DateRange[]>;
  /** No regular class inside a term window (winter break). */
  breaks: DateRange[];
  /** No class: 臨時の休業日, 早稲田祭, national holidays that are not 授業を行う祝日. date -> name */
  closed: Record<string, string>;
  /** Classes ARE held on this holiday (授業を行う祝日). date -> name */
  held: Record<string, string>;
  /** 振替授業日: a date that follows another weekday's schedule. date -> weekday (Mon = 1). None published for AY2026. */
  weekdayOverride: Record<string, number>;
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ------------------------------------------------------------------ ISO date helpers (no timezone involved)

const utcOf = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** Mon = 1 ... Sun = 7. */
export const weekdayOf = (iso: string): number => ((new Date(utcOf(iso)).getUTCDay() + 6) % 7) + 1;

export const addDays = (iso: string, n: number): string =>
  new Date(utcOf(iso) + n * 86_400_000).toISOString().slice(0, 10);

/** True for a real calendar date written 'YYYY-MM-DD'. */
export const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;

/** The academic year starts in April: January-March belong to the previous year. */
const academicYearOf = (iso: string): number => Number(iso.slice(0, 4)) - (Number(iso.slice(5, 7)) <= 3 ? 1 : 0);

const inRanges = (iso: string, ranges: readonly DateRange[] | undefined): boolean =>
  (ranges ?? []).some(([from, to]) => iso >= from && iso <= to);

// ------------------------------------------------------------------ calendars

/** Month rules of AY2026 applied to any year. */
function approximateCalendar(year: number): AcademicCalendar {
  const y = String(year);
  const next = String(year + 1);
  const spring: DateRange = [`${y}-04-11`, `${y}-07-29`];
  const fall: DateRange = [`${y}-10-01`, `${next}-02-02`];
  const terms: Record<string, DateRange[]> = {
    春学期: [spring],
    春クォーター: [[`${y}-04-11`, `${y}-06-03`]],
    夏クォーター: [[`${y}-06-04`, `${y}-07-29`]],
    秋学期: [fall],
    秋クォーター: [[`${y}-10-01`, `${y}-11-21`]],
    冬クォーター: [[`${y}-11-23`, `${next}-02-02`]],
    通年: [spring, fall],
  };
  return {
    year,
    official: false,
    terms,
    shortTerms: {},
    breaks: [[`${y}-12-22`, `${next}-01-05`]],
    closed: {},
    held: {},
    weekdayOverride: {},
  };
}

/** Published AY2026 calendar. */
export const ACADEMIC_CALENDAR: AcademicCalendar = {
  ...approximateCalendar(2026),
  official: true,
  shortTerms: {
    春学期: [['2026-04-11', '2026-07-22']],
    夏クォーター: [['2026-06-04', '2026-07-22']],
    秋学期: [['2026-10-01', '2027-01-26']],
    冬クォーター: [['2026-11-23', '2027-01-26']],
    通年: [
      ['2026-04-11', '2026-07-22'],
      ['2026-10-01', '2027-01-26'],
    ],
  },
  closed: {
    '2026-05-03': '憲法記念日',
    '2026-05-04': 'みどりの日',
    '2026-05-05': 'こどもの日',
    '2026-05-06': '振替休日',
    '2026-11-05': '臨時の休業日',
    '2026-11-06': '臨時の休業日',
    '2026-11-07': '早稲田祭',
    '2026-11-08': '早稲田祭',
    '2026-12-25': '臨時の休業日',
    '2026-12-28': '臨時の休業日',
    '2027-01-11': '成人の日',
  },
  held: {
    '2026-04-29': '昭和の日',
    '2026-07-20': '海の日',
    '2026-10-12': 'スポーツの日',
    '2026-10-21': '創立記念日',
    '2026-11-03': '文化の日',
    '2026-11-23': '勤労感謝の日',
  },
};

export function calendarFor(iso: string): AcademicCalendar {
  const year = academicYearOf(iso);
  return year === ACADEMIC_CALENDAR.year ? ACADEMIC_CALENDAR : approximateCalendar(year);
}

// ------------------------------------------------------------------ queries

/** Windows that apply to a school; WBS / CJL (`short`) end their classes a week earlier. */
const windowsOf = (calendar: AcademicCalendar, term: string, short: boolean): DateRange[] | undefined =>
  (short ? calendar.shortTerms[term] : undefined) ?? calendar.terms[term];

/**
 * Whether `term` holds classes on `iso` (breaks and closed days are NOT considered here).
 * `null` (a cell without a recognised term) counts as a semester course; 集中 never has weekly classes.
 */
export function termCovers(
  calendar: AcademicCalendar,
  query: { iso: string; term: string | null; short: boolean },
): boolean {
  const { iso, term, short } = query;
  if (term === '集中') return false;
  if (term === null) return ['春学期', '秋学期'].some((t) => inRanges(iso, windowsOf(calendar, t, short)));
  return inRanges(iso, windowsOf(calendar, term, short));
}

export interface DayStatus {
  /** No regular class today (closed day, break or outside every term). */
  closed: boolean;
  /** Weekday whose schedule applies (differs from the calendar weekday on a 振替 day). */
  weekday: number;
  note: string | null;
}

const insideAnyTerm = (calendar: AcademicCalendar, iso: string) =>
  Object.values(calendar.terms).some((ranges) => inRanges(iso, ranges));

/** Closed / held / swapped status of a date with the note shown to the user. */
export function dayStatus(calendar: AcademicCalendar, iso: string): DayStatus {
  const calendarWeekday = weekdayOf(iso);
  const weekday = calendar.weekdayOverride[iso] ?? calendarWeekday;
  const closedName = calendar.closed[iso];
  const notes: string[] = [];
  let closed = false;
  if (closedName !== undefined) {
    closed = true;
    notes.push(`No classes: ${closedName}`);
  } else if (inRanges(iso, calendar.breaks)) {
    closed = true;
    notes.push('No classes: winter break');
  } else if (calendar.official && !insideAnyTerm(calendar, iso)) {
    closed = true;
    notes.push('No classes: outside the class period (term break)');
  }
  const heldName = calendar.held[iso];
  if (heldName !== undefined && !closed) notes.push(`Classes are held: ${heldName}`);
  if (weekday !== calendarWeekday) notes.push(`Follows the ${WEEKDAY_NAMES[weekday - 1] ?? ''} schedule (振替)`);
  return { closed, weekday, note: notes.join('; ') || null };
}
