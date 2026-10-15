/**
 * Class times inferred from the attendance sessions Moodle shows as calendar events (eventtype 'attendance'): used for
 * courses whose public syllabus gives no usable slot. Per user, cached for 7 days, never in the global syllabus cache.
 */

import type { ServiceContext } from '../../context';
import { BudgetExceeded, MoodleError, MoodleUnavailable } from '../../errors';
import { jstParts, nowMs } from '../../time';
import type { InferredSchedule } from '../../types';
import { EVENING_TIMES, STANDARD_TIMES } from './periods';

const EVENTS_FN = 'core_calendar_get_calendar_events';
const CACHE_TTL_MS = 7 * 86_400_000;
/**
 * One 100-minute period is 6000 s, a 90-minute one 5400 s; a minute of slack either way. Anything longer is no class
 * meeting (the all-day on-demand attendance windows are ~86340 s).
 */
const MIN_DURATION_SEC = 5400 - 60;
const MAX_DURATION_SEC = 6000 + 60;
/** A slot counts only when it recurs: a period seen on a single date is a one-off event. */
const MIN_SESSIONS = 2;
const DAY_SEC = 86_400;
const JST_OFFSET_SEC = 9 * 3600;
const FIRST_ACADEMIC_MONTH = 4;
const LAST_WEEKDAY_WITH_NIGHT_CLOCK = 5; // Mon-Fri; a Saturday evening start uses the standard clock
const ON_DEMAND_RE = /オンデマンド|on-?demand/i;

/** The fields of a `core_calendar_get_calendar_events` event this module reads. */
interface CalendarEvent {
  courseid?: number;
  eventtype?: string;
  modulename?: string;
  name?: string;
  timestart?: number;
  timeduration?: number;
}

interface CourseWindow {
  id: number;
  start: number | null;
  end: number | null;
}

type Slot = InferredSchedule['slots'][number];
type Answers = Map<number, InferredSchedule>;

/** One attendance session reduced to what recurs: the weekday (Mon=1), the period and the JST date. */
interface Session {
  courseId: number;
  weekday: number;
  period: number;
  night: boolean;
  date: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Period and clock of a JST 'HH:MM' start on a weekday; null when it is no period start. */
function periodAt(weekday: number, hhmm: string): Pick<Session, 'period' | 'night'> | null {
  if (weekday <= LAST_WEEKDAY_WITH_NIGHT_CLOCK) {
    const evening = EVENING_TIMES.find((t) => t.start === hhmm);
    if (evening) return { period: evening.period, night: true };
  }
  const standard = STANDARD_TIMES.find((t) => t.start === hhmm);
  return standard ? { period: standard.period, night: false } : null;
}

function isClassMeeting(e: CalendarEvent): boolean {
  const duration = e.timeduration ?? 0;
  if (e.eventtype !== 'attendance' && e.modulename !== 'attendance') return false;
  if (duration < MIN_DURATION_SEC || duration > MAX_DURATION_SEC) return false;
  return !ON_DEMAND_RE.test(e.name ?? '');
}

function sessionOf(e: CalendarEvent): Session | null {
  if (!e.courseid || !e.timestart || !isClassMeeting(e)) return null;
  const p = jstParts(e.timestart * 1000);
  const weekday = p.wd === 0 ? 7 : p.wd;
  const at = periodAt(weekday, `${pad(p.h)}:${pad(p.mi)}`);
  return at && { courseId: e.courseid, weekday, ...at, date: `${p.y}-${pad(p.mo)}-${pad(p.d)}` };
}

/** Periods (per weekday and clock) seen on at least MIN_SESSIONS dates, each with its dates; in week order. */
function recurringPeriods(sessions: Session[]): { cell: Session; dates: string[] }[] {
  const cells = new Map<string, { cell: Session; dates: Set<string> }>();
  for (const s of sessions) {
    const key = `${s.weekday}:${s.night}:${s.period}`;
    const hit = cells.get(key) ?? { cell: s, dates: new Set<string>() };
    hit.dates.add(s.date);
    cells.set(key, hit);
  }
  return [...cells.values()]
    .filter((c) => c.dates.size >= MIN_SESSIONS)
    .map((c) => ({ cell: c.cell, dates: [...c.dates] }))
    .sort((a, b) => a.cell.weekday - b.cell.weekday || a.cell.period - b.cell.period);
}

const continues = (slot: Slot | undefined, next: Session): slot is Slot =>
  slot !== undefined && slot.weekday === next.weekday && slot.night === next.night && slot.periodTo + 1 === next.period;

const startSlot = ({ weekday, period, night }: Session): Slot => ({
  weekday,
  periodFrom: period,
  periodTo: period,
  night,
  classroom: null,
});

/** Consecutive periods of one weekday and clock become one slot (P1 + P2 -> P1–2). */
function collapse(periods: Session[]): Slot[] {
  const slots: Slot[] = [];
  for (const next of periods) {
    const last = slots[slots.length - 1];
    if (continues(last, next)) last.periodTo = next.period;
    else slots.push(startSlot(next));
  }
  return slots;
}

function scheduleOf(sessions: Session[], checkedAt: number): InferredSchedule {
  const recurring = recurringPeriods(sessions);
  const dates = recurring.flatMap((r) => r.dates).sort();
  return {
    slots: collapse(recurring.map((r) => r.cell)),
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    checkedAt,
  };
}

/**
 * Weekly meetings per course from calendar events: attendance sessions of one 90/100-minute period, mapped to a 時限
 * by their JST start (the night clock for weekday evening starts), recurring on at least two dates. Only courses with a
 * slot are in the result; the classroom is not known from the events. `at` becomes the schedules' checkedAt.
 */
export function schedulesFromEvents(events: readonly CalendarEvent[], at: number): Answers {
  const byCourse = new Map<number, Session[]>();
  for (const e of events) {
    const s = sessionOf(e);
    if (s) byCourse.set(s.courseId, [...(byCourse.get(s.courseId) ?? []), s]);
  }
  const out: Answers = new Map();
  for (const [courseId, sessions] of byCourse) {
    const schedule = scheduleOf(sessions, at);
    if (schedule.slots.length > 0) out.set(courseId, schedule);
  }
  return out;
}

/** [min start, max end] of the courses, capped to the current academic year (April to March, JST). */
function eventWindow(courses: CourseWindow[], nowMillis: number): { from: number; to: number } {
  const { y, mo } = jstParts(nowMillis);
  const year = mo >= FIRST_ACADEMIC_MONTH ? y : y - 1;
  const yearStart = Date.UTC(year, FIRST_ACADEMIC_MONTH - 1, 1) / 1000 - JST_OFFSET_SEC;
  const yearEnd = Date.UTC(year + 1, FIRST_ACADEMIC_MONTH - 1, 1) / 1000 - JST_OFFSET_SEC - 1;
  const starts = courses.map((c) => c.start ?? 0).filter((t) => t > 0);
  const ends = courses.map((c) => c.end ?? 0).filter((t) => t > 0);
  const from = Math.max(yearStart, starts.length > 0 ? Math.min(...starts) : yearStart);
  const to = Math.min(yearEnd, ends.length > 0 ? Math.max(...ends) : yearEnd);
  return from < to - DAY_SEC ? { from, to } : { from: yearStart, to: yearEnd };
}

/** ONE call for all courses; any Moodle failure (refusing, unreachable, the request's call budget) gives null. */
async function fetchEvents(ctx: ServiceContext, courses: CourseWindow[], now: number): Promise<CalendarEvent[] | null> {
  const { from, to } = eventWindow(courses, now);
  try {
    const api = await ctx.moodle();
    const res = await api.call<{ events?: CalendarEvent[] }>(EVENTS_FN, {
      events: { courseids: courses.map((c) => c.id) },
      options: { userevents: 0, siteevents: 0, timestart: from, timeend: to },
    });
    return Array.isArray(res?.events) ? res.events : [];
  } catch (e) {
    if (e instanceof MoodleError || e instanceof MoodleUnavailable || e instanceof BudgetExceeded) return null;
    throw e;
  }
}

/** Asks Moodle about the courses and caches every answer, an empty one too; an empty map when Moodle fails. */
async function lookUp(ctx: ServiceContext, courses: CourseWindow[], now: number): Promise<Answers> {
  const events = await fetchEvents(ctx, courses, now);
  if (events === null) return new Map();
  const found = schedulesFromEvents(events, now);
  const answers: Answers = new Map(
    courses.map((c) => [c.id, found.get(c.id) ?? { slots: [], firstDate: null, lastDate: null, checkedAt: now }]),
  );
  // a failed cache write only costs the next call another lookup
  ctx.defer(ctx.store.putInferredSchedules(ctx.user.id, answers).catch(() => undefined));
  return answers;
}

/**
 * Weekly class times of the given courses from Moodle's attendance sessions, for courses the syllabus cannot place.
 * Reads the per-user cache (7 days; "none found" is cached too) and asks Moodle with ONE call for the missing or stale
 * courses only. When Moodle fails the cached answers (stale ones included) are returned. A course without a recurring
 * session is not in the result. `start` / `end` are the Moodle course dates in unix seconds.
 */
export async function inferSchedules(ctx: ServiceContext, courses: CourseWindow[]): Promise<Answers> {
  const now = nowMs();
  const unique = [...new Map(courses.map((c) => [c.id, c])).values()];
  const cached = await ctx.store.getInferredSchedules(ctx.user.id);
  const stale = unique.filter((c) => {
    const hit = cached.get(c.id);
    return !hit || now - hit.checkedAt >= CACHE_TTL_MS;
  });
  const fresh: Answers = stale.length > 0 ? await lookUp(ctx, stale, now) : new Map();
  const out: Answers = new Map();
  for (const c of unique) {
    const schedule = fresh.get(c.id) ?? cached.get(c.id);
    if (schedule && schedule.slots.length > 0) out.set(c.id, schedule);
  }
  return out;
}
