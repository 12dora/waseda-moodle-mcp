/** 時限 clocks (2026年度 授業時間, 教務部; WBS night column from the WBS 研究科日程). */

import type { PeriodTime } from '../../types';
import type { SyllabusSlot } from '../syllabus';

/** 全体: undergraduate, most graduate schools, 理工, CJL, 全日制 WBS. 7限 is 50 minutes here. */
export const STANDARD_TIMES: readonly PeriodTime[] = [
  { period: 1, start: '08:50', end: '10:30' },
  { period: 2, start: '10:40', end: '12:20' },
  { period: 3, start: '13:10', end: '14:50' },
  { period: 4, start: '15:05', end: '16:45' },
  { period: 5, start: '17:00', end: '18:40' },
  { period: 6, start: '18:55', end: '20:35' },
  { period: 7, start: '20:45', end: '21:35' },
];

/** 夜間主 (WBS and other night graduate schools), Mon-Fri 夜6-7 only: both periods are 100 minutes. */
export const EVENING_TIMES: readonly PeriodTime[] = [
  { period: 6, start: '18:30', end: '20:10' },
  { period: 7, start: '20:20', end: '22:00' },
];

const SATURDAY = 6;

type SlotTime = Pick<SyllabusSlot, 'weekday' | 'periodFrom' | 'periodTo' | 'night'>;

/** The night clock applies to 夜 slots on weekdays; a Saturday 夜 slot uses 全体 (WBS 夜間主 Saturday). */
const usesEveningClock = (slot: SlotTime) => slot.night && slot.weekday < SATURDAY;

function clockOf(period: number, evening: boolean): PeriodTime | undefined {
  return (
    (evening ? EVENING_TIMES : []).find((t) => t.period === period) ?? STANDARD_TIMES.find((t) => t.period === period)
  );
}

/** Start of the first period to end of the last period of a slot; null when a period has no clock. */
export function slotClock(slot: SlotTime): { start: string; end: string } | null {
  const evening = usesEveningClock(slot);
  const first = clockOf(slot.periodFrom, evening);
  const last = clockOf(slot.periodTo, evening);
  return first && last ? { start: first.start, end: last.end } : null;
}

export const periodsLabel = (slot: SlotTime): string =>
  slot.periodFrom === slot.periodTo ? `P${slot.periodFrom}` : `P${slot.periodFrom}–${slot.periodTo}`;
