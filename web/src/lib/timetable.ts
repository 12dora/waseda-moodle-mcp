/** Timetable view helpers: dates, visible days and grid blocks. Period numbers and times come from the server. */

import type { TimetableClass, TimetableDay } from '../api/types';

const DAY_MS = 86_400_000;
const JST_MS = 9 * 3600 * 1000;

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const fromDayNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** Today's date in JST as YYYY-MM-DD. */
export function todayJst(nowMs: number = Date.now()): string {
  return new Date(nowMs + JST_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}

/** 1 = Monday … 7 = Sunday. */
function isoWeekday(date: string): number {
  return ((dayNumber(date) + 3) % 7) + 1; // 1970-01-01 was a Thursday
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** Week grid columns: Mon–Sat, plus Sunday only when it has classes. */
export function visibleDays(days: TimetableDay[]): TimetableDay[] {
  return days.filter((d) => d.weekday !== 7 || d.classes.length > 0);
}

export interface PeriodBlock {
  from: number;
  to: number;
  classes: TimetableClass[];
}

/** Classes of one day merged into blocks: overlapping period ranges become one block spanning their union. */
export function periodBlocks(classes: TimetableClass[]): PeriodBlock[] {
  const sorted = [...classes].sort((a, b) => a.periodFrom - b.periodFrom || a.periodTo - b.periodTo);
  const blocks: PeriodBlock[] = [];
  for (const c of sorted) {
    const last = blocks.at(-1);
    if (last && c.periodFrom <= last.to) {
      last.to = Math.max(last.to, c.periodTo);
      last.classes.push(c);
    } else {
      blocks.push({ from: c.periodFrom, to: c.periodTo, classes: [c] });
    }
  }
  return blocks;
}
