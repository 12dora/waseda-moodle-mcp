/** Timetable grid helpers. Period times are the official AY2026 全体 table (contract §14, r6 §1). */

export const PERIODS: ReadonlyArray<{ n: number; start: string; end: string }> = [
  { n: 1, start: '08:50', end: '10:30' },
  { n: 2, start: '10:40', end: '12:20' },
  { n: 3, start: '13:10', end: '14:50' },
  { n: 4, start: '15:05', end: '16:45' },
  { n: 5, start: '17:00', end: '18:40' },
  { n: 6, start: '18:55', end: '20:35' },
  { n: 7, start: '20:45', end: '21:35' },
];

const DAY_MS = 86_400_000;
const JST_MS = 9 * 3600 * 1000;

const minutes = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

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
export function isoWeekday(date: string): number {
  return ((dayNumber(date) + 3) % 7) + 1; // 1970-01-01 was a Thursday
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/**
 * Grid rows a class occupies: periods overlapping it by at least 30 min (or half the class when shorter). Night
 * variants such as WBS 18:30–20:10 / 20:20–22:00 therefore land on periods 6 / 7.
 */
export function periodSpan(start: string, end: string): { from: number; to: number } {
  const s = minutes(start);
  const e = minutes(end);
  const need = Math.min(30, (e - s) / 2);
  const hits = PERIODS.filter((p) => Math.min(e, minutes(p.end)) - Math.max(s, minutes(p.start)) >= need).map(
    (p) => p.n,
  );
  const first = hits[0];
  const last = hits.at(-1);
  if (first !== undefined && last !== undefined) return { from: first, to: last };
  const nearest = PERIODS.find((p) => minutes(p.end) > s)?.n ?? PERIODS.length;
  return { from: nearest, to: nearest };
}
