/** Schedule editor form state and its mapping to / from ScheduleOverride (contract §15.4, §15.6). */

import type { ScheduleOverride, Timetable, TimetableDay } from '../api/types';

export type ScheduleMode = ScheduleOverride['mode'];

export interface SlotRow {
  key: string; // stable React key for the editor row
  weekday: number; // 1 = Mon … 7 = Sun
  from: number; // period 1–7
  to: number;
  night: boolean; // WBS weekday evening clock (Mon–Fri, periods 6–7 only)
  room: string;
}

export interface ScheduleForm {
  mode: ScheduleMode;
  rows: SlotRow[]; // always ≥ 1 so switching to 'slots' has a row to edit
  alsoOnDemand: boolean; // weekly mode only: a hybrid that also has on-demand work
}

export type RowError = 'range' | 'overlap' | 'room';

export const MAX_ROWS = 6;
export const CLASSROOM_MAX = 40;
const NIGHT_FIRST_PERIOD = 6;
const NIGHT_LAST_WEEKDAY = 5;

let rowSeq = 0;
const rowKey = () => `row-${++rowSeq}`;

export const emptyRow = (): SlotRow => ({ key: rowKey(), weekday: 1, from: 1, to: 1, night: false, room: '' });

const withRows = (mode: ScheduleMode, rows: SlotRow[], alsoOnDemand = false): ScheduleForm => ({
  mode,
  rows: rows.length > 0 ? rows.slice(0, MAX_ROWS) : [emptyRow()],
  alsoOnDemand,
});

/** The evening clock exists only on weekdays and only for periods 6–7. */
/** A reversed range has its own error; it must not clear `night` while the user is still picking the periods. */
export const nightAllowed = (row: SlotRow): boolean =>
  row.weekday <= NIGHT_LAST_WEEKDAY && row.from >= NIGHT_FIRST_PERIOD;

/** Clears `night` once the row no longer allows the evening clock. */
export const normalizeRow = (row: SlotRow): SlotRow =>
  row.night && !nightAllowed(row) ? { ...row, night: false } : row;

/** The weekday whose schedule a date follows (a 振替 day follows another weekday). */
function scheduleWeekday(day: TimetableDay): number {
  for (const n of day.notes) if (n.kind === 'swap') return n.weekday;
  return day.weekday;
}

/** The course's weekly slots as shown in the loaded week, one row per distinct weekday + period range + clock. */
function rowsFromDays(courseId: number, days: TimetableDay[]): SlotRow[] {
  const rows = new Map<string, SlotRow>();
  for (const day of days) {
    const weekday = scheduleWeekday(day);
    for (const c of day.classes) {
      if (c.courseId !== courseId) continue;
      const key = `${weekday}-${c.periodFrom}-${c.periodTo}-${c.night}`;
      if (rows.has(key)) continue;
      const row = { key: rowKey(), weekday, from: c.periodFrom, to: c.periodTo, night: c.night };
      rows.set(key, normalizeRow({ ...row, room: c.classroom ?? '' }));
    }
  }
  return [...rows.values()];
}

function formFromOverride(o: ScheduleOverride): ScheduleForm {
  const rows = o.slots.map((s) =>
    normalizeRow({
      key: rowKey(),
      weekday: s.weekday,
      from: s.periodFrom,
      to: s.periodTo,
      night: s.night,
      room: s.classroom ?? '',
    }),
  );
  return withRows(o.mode, rows, o.mode === 'slots' && o.alsoOnDemand);
}

/** Starting values: the user's override, else what the timetable currently shows for the course. */
export function initialForm(
  courseId: number,
  { override, timetable }: { override: ScheduleOverride | undefined; timetable: Timetable },
): ScheduleForm {
  if (override) return formFromOverride(override);
  const unscheduled = timetable.onDemand.find((c) => c.courseId === courseId);
  const rows = rowsFromDays(courseId, timetable.days);
  if (rows.length > 0) return withRows('slots', rows, unscheduled?.kind === 'on-demand' && unscheduled.alsoInClass);
  if (unscheduled) return withRows(unscheduled.kind === 'on-demand' ? 'on-demand' : 'none', []);
  return withRows('slots', []);
}

const overlaps = (a: SlotRow, b: SlotRow): boolean => a.weekday === b.weekday && a.from <= b.to && b.from <= a.to;

/** The first problem of each row (null = fine): reversed range, overlap with an earlier row, or a too-long room. */
export function rowErrors(rows: SlotRow[]): (RowError | null)[] {
  return rows.map((row, i) => {
    if (row.from > row.to) return 'range';
    if (rows.slice(0, i).some((prev) => prev.from <= prev.to && overlaps(prev, row))) return 'overlap';
    if (row.room.trim().length > CLASSROOM_MAX) return 'room';
    return null;
  });
}

export function formValid(form: ScheduleForm): boolean {
  return form.mode !== 'slots' || (form.rows.length > 0 && rowErrors(form.rows).every((e) => e === null));
}

export function toOverride(form: ScheduleForm): ScheduleOverride {
  if (form.mode !== 'slots') return { mode: form.mode, slots: [], alsoOnDemand: false };
  return {
    mode: 'slots',
    slots: form.rows.slice(0, MAX_ROWS).map((r) => ({
      weekday: r.weekday,
      periodFrom: r.from,
      periodTo: r.to,
      night: r.night && nightAllowed(r),
      classroom: r.room.trim() || null,
    })),
    alsoOnDemand: form.alsoOnDemand,
  };
}
