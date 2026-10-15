import { describe, expect, it } from 'vitest';
import type { Timetable, TimetableClass } from '../api/types';
import {
  formValid,
  initialForm,
  normalizeRow,
  rowErrors,
  type ScheduleForm,
  type SlotRow,
  toOverride,
} from './scheduleForm';

interface ClsOpts {
  periodFrom: number;
  periodTo: number;
  classroom?: string;
  night?: boolean;
}

const cls = (courseId: number, { periodFrom, periodTo, classroom, night }: ClsOpts): TimetableClass => ({
  courseId,
  courseName: `C${courseId}`,
  start: '08:50',
  end: '12:20',
  periods: `P${periodFrom}–${periodTo}`,
  periodFrom,
  periodTo,
  night: night ?? false,
  classroom: classroom ?? null,
  campus: null,
  url: 'https://example.com/course',
  source: 'syllabus',
});

const timetable = (patch: Partial<Timetable> = {}): Timetable => ({
  from: '2026-10-12',
  to: '2026-10-18',
  days: [],
  onDemand: [],
  unknown: [],
  periodTimes: { standard: [], evening: [] },
  scopeMode: 'mine',
  approximate: false,
  ...patch,
});

const shape = (f: ScheduleForm) => ({
  mode: f.mode,
  alsoOnDemand: f.alsoOnDemand,
  rows: f.rows.map((r) => ({ weekday: r.weekday, from: r.from, to: r.to, night: r.night, room: r.room })),
});

describe('initialForm', () => {
  it('starts from the override', () => {
    const override = {
      mode: 'slots' as const,
      slots: [{ weekday: 5, periodFrom: 6, periodTo: 7, night: true, classroom: '22-909' }],
      alsoOnDemand: true,
    };
    expect(shape(initialForm(7, { override, timetable: timetable() }))).toEqual({
      mode: 'slots',
      alsoOnDemand: true,
      rows: [{ weekday: 5, from: 6, to: 7, night: true, room: '22-909' }],
    });
  });

  it('derives distinct rows from the shown week, following swapped weekdays', () => {
    const a = cls(7, { periodFrom: 1, periodTo: 2, classroom: 'A' });
    const days = [
      { date: '2026-10-12', weekday: 1, notes: [], classes: [a, cls(8, { periodFrom: 3, periodTo: 3 })] },
      { date: '2026-10-14', weekday: 3, notes: [{ kind: 'swap' as const, weekday: 1 }], classes: [a] },
      { date: '2026-10-16', weekday: 5, notes: [], classes: [cls(7, { periodFrom: 4, periodTo: 4 })] },
    ];
    expect(shape(initialForm(7, { override: undefined, timetable: timetable({ days }) }))).toEqual({
      mode: 'slots',
      alsoOnDemand: false,
      rows: [
        { weekday: 1, from: 1, to: 2, night: false, room: 'A' },
        { weekday: 5, from: 4, to: 4, night: false, room: '' },
      ],
    });
  });

  it('keeps the evening clock, the hybrid flag and the full room', () => {
    const room = 'R'.repeat(45);
    const evening = cls(7, { periodFrom: 6, periodTo: 7, night: true, classroom: room });
    const days = [{ date: '2026-10-12', weekday: 1, notes: [], classes: [evening] }];
    const ref = { courseId: 7, courseName: 'C7', url: 'u', term: null };
    const onDemand = [{ ...ref, kind: 'on-demand' as const, alsoInClass: true }];
    const form = initialForm(7, { override: undefined, timetable: timetable({ days, onDemand }) });
    expect(shape(form)).toEqual({
      mode: 'slots',
      alsoOnDemand: true,
      rows: [{ weekday: 1, from: 6, to: 7, night: true, room }],
    });
    expect(rowErrors(form.rows)).toEqual(['room']);
    expect(formValid(form)).toBe(false);
  });

  it('uses the unscheduled kind, else one empty weekly row', () => {
    const ref = { courseId: 7, courseName: 'C7', url: 'u', term: null, alsoInClass: false };
    const od = timetable({ onDemand: [{ ...ref, kind: 'no-fixed-time' }] });
    expect(initialForm(7, { override: undefined, timetable: od }).mode).toBe('none');
    const blank = initialForm(7, { override: undefined, timetable: timetable() });
    expect(shape(blank)).toEqual({
      mode: 'slots',
      alsoOnDemand: false,
      rows: [{ weekday: 1, from: 1, to: 1, night: false, room: '' }],
    });
  });
});

describe('formValid / toOverride', () => {
  const row = (from: number, to: number, patch: Partial<SlotRow> = {}): SlotRow => ({
    key: `${from}-${to}`,
    weekday: 2,
    from,
    to,
    night: false,
    room: '',
    ...patch,
  });
  const weekly = (rows: SlotRow[], alsoOnDemand = false): ScheduleForm => ({ mode: 'slots', rows, alsoOnDemand });

  it('rejects a reversed period range only in weekly mode', () => {
    expect(formValid(weekly([row(3, 2)]))).toBe(false);
    expect(formValid(weekly([row(2, 3)]))).toBe(true);
    expect(formValid({ mode: 'on-demand', rows: [row(3, 2)], alsoOnDemand: false })).toBe(true);
  });

  it('keeps the evening clock while the range is briefly reversed during editing', () => {
    const row: SlotRow = { key: 'r', weekday: 1, from: 7, to: 6, night: true, room: '' };
    expect(normalizeRow(row).night).toBe(true);
    expect(normalizeRow({ ...row, weekday: 6 }).night).toBe(false); // Saturday has no evening clock
    expect(normalizeRow({ ...row, from: 5 }).night).toBe(false);
  });

  it('flags overlapping and duplicate rows on the same weekday', () => {
    expect(rowErrors([row(1, 2), row(2, 3)])).toEqual([null, 'overlap']);
    expect(rowErrors([row(1, 2), row(1, 2)])).toEqual([null, 'overlap']);
    expect(rowErrors([row(1, 2), row(1, 2, { weekday: 3 }), row(3, 4)])).toEqual([null, null, null]);
    expect(formValid(weekly([row(1, 2), row(2, 2)]))).toBe(false);
  });

  it('maps weekly rows, trimming rooms and keeping the evening clock only where it exists', () => {
    const rows = [
      row(1, 2, { room: ' 22-909 ' }),
      row(6, 7, { night: true, room: '  ' }),
      row(6, 7, { weekday: 6, night: true }),
    ];
    expect(toOverride(weekly(rows, true))).toEqual({
      mode: 'slots',
      slots: [
        { weekday: 2, periodFrom: 1, periodTo: 2, night: false, classroom: '22-909' },
        { weekday: 2, periodFrom: 6, periodTo: 7, night: true, classroom: null },
        { weekday: 6, periodFrom: 6, periodTo: 7, night: false, classroom: null },
      ],
      alsoOnDemand: true,
    });
  });

  it('drops rows and the hybrid flag for other modes', () => {
    expect(toOverride({ mode: 'none', rows: [row(1, 1)], alsoOnDemand: true })).toEqual({
      mode: 'none',
      slots: [],
      alsoOnDemand: false,
    });
  });
});
