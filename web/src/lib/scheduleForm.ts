/** Schedule editor form state and its mapping to / from ScheduleOverride (contract §15.4). */

import type { ScheduleOverride, Timetable, TimetableDay } from '../api/types';

export type ScheduleMode = ScheduleOverride['mode'];

export interface SlotRow {
  key: string; // stable React key for the editor row
  weekday: number; // 1 = Mon … 7 = Sun
  from: number; // period 1–7
  to: number;
  room: string;
}

export interface ScheduleForm {
  mode: ScheduleMode;
  rows: SlotRow[]; // always ≥ 1 so switching to 'slots' has a row to edit
}

export const MAX_ROWS = 6;
export const CLASSROOM_MAX = 40;

let rowSeq = 0;
const rowKey = () => `row-${++rowSeq}`;

export const emptyRow = (): SlotRow => ({ key: rowKey(), weekday: 1, from: 1, to: 1, room: '' });

const withRows = (mode: ScheduleMode, rows: SlotRow[]): ScheduleForm => ({
  mode,
  rows: rows.length > 0 ? rows.slice(0, MAX_ROWS) : [emptyRow()],
});

/** The weekday whose schedule a date follows (a 振替 day follows another weekday). */
function scheduleWeekday(day: TimetableDay): number {
  for (const n of day.notes) if (n.kind === 'swap') return n.weekday;
  return day.weekday;
}

/** The course's weekly slots as shown in the loaded week, one row per distinct weekday + period range. */
function rowsFromDays(courseId: number, days: TimetableDay[]): SlotRow[] {
  const rows = new Map<string, SlotRow>();
  for (const day of days) {
    const weekday = scheduleWeekday(day);
    for (const c of day.classes) {
      if (c.courseId !== courseId) continue;
      const key = `${weekday}-${c.periodFrom}-${c.periodTo}`;
      if (rows.has(key)) continue;
      rows.set(key, { key: rowKey(), weekday, from: c.periodFrom, to: c.periodTo, room: c.classroom ?? '' });
    }
  }
  return [...rows.values()];
}

function formFromOverride(o: ScheduleOverride): ScheduleForm {
  const rows = o.slots.map((s) => ({
    key: rowKey(),
    weekday: s.weekday,
    from: s.periodFrom,
    to: s.periodTo,
    room: s.classroom ?? '',
  }));
  return withRows(o.mode, rows);
}

/** Starting values: the user's override, else what the timetable currently shows for the course. */
export function initialForm(
  courseId: number,
  { override, timetable }: { override: ScheduleOverride | undefined; timetable: Timetable },
): ScheduleForm {
  if (override) return formFromOverride(override);
  const rows = rowsFromDays(courseId, timetable.days);
  if (rows.length > 0) return withRows('slots', rows);
  const unscheduled = timetable.onDemand.find((c) => c.courseId === courseId);
  if (unscheduled) return withRows(unscheduled.kind === 'on-demand' ? 'on-demand' : 'none', []);
  return withRows('slots', []);
}

export const rowInvalid = (row: SlotRow): boolean => row.from > row.to;

export function formValid(form: ScheduleForm): boolean {
  return form.mode !== 'slots' || (form.rows.length > 0 && !form.rows.some(rowInvalid));
}

export function toOverride(form: ScheduleForm): ScheduleOverride {
  if (form.mode !== 'slots') return { mode: form.mode, slots: [] };
  return {
    mode: 'slots',
    slots: form.rows.slice(0, MAX_ROWS).map((r) => ({
      weekday: r.weekday,
      periodFrom: r.from,
      periodTo: r.to,
      classroom: r.room.trim().slice(0, CLASSROOM_MAX) || null,
    })),
  };
}
