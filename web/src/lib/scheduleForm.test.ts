import { describe, expect, it } from 'vitest';
import type { Timetable, TimetableClass } from '../api/types';
import { formValid, initialForm, type ScheduleForm, toOverride } from './scheduleForm';

interface ClsOpts {
  periodFrom: number;
  periodTo: number;
  classroom?: string;
}

const cls = (courseId: number, { periodFrom, periodTo, classroom }: ClsOpts): TimetableClass => ({
  courseId,
  courseName: `C${courseId}`,
  start: '08:50',
  end: '12:20',
  periods: `P${periodFrom}–${periodTo}`,
  periodFrom,
  periodTo,
  night: false,
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
  rows: f.rows.map((r) => ({ weekday: r.weekday, from: r.from, to: r.to, room: r.room })),
});

describe('initialForm', () => {
  it('starts from the override', () => {
    const override = {
      mode: 'slots' as const,
      slots: [{ weekday: 5, periodFrom: 1, periodTo: 2, classroom: '22-909' }],
    };
    expect(shape(initialForm(7, { override, timetable: timetable() }))).toEqual({
      mode: 'slots',
      rows: [{ weekday: 5, from: 1, to: 2, room: '22-909' }],
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
      rows: [
        { weekday: 1, from: 1, to: 2, room: 'A' },
        { weekday: 5, from: 4, to: 4, room: '' },
      ],
    });
  });

  it('uses the unscheduled kind, else one empty weekly row', () => {
    const ref = { courseId: 7, courseName: 'C7', url: 'u', term: null, alsoInClass: false };
    const od = timetable({ onDemand: [{ ...ref, kind: 'no-fixed-time' }] });
    expect(initialForm(7, { override: undefined, timetable: od }).mode).toBe('none');
    const blank = initialForm(7, { override: undefined, timetable: timetable() });
    expect(shape(blank)).toEqual({ mode: 'slots', rows: [{ weekday: 1, from: 1, to: 1, room: '' }] });
  });
});

describe('formValid / toOverride', () => {
  const row = (from: number, to: number, room = '') => ({ key: `${from}-${to}`, weekday: 2, from, to, room });

  it('rejects a reversed period range only in weekly mode', () => {
    expect(formValid({ mode: 'slots', rows: [row(3, 2)] })).toBe(false);
    expect(formValid({ mode: 'slots', rows: [row(2, 3)] })).toBe(true);
    expect(formValid({ mode: 'on-demand', rows: [row(3, 2)] })).toBe(true);
  });

  it('maps weekly rows, trimming rooms', () => {
    expect(toOverride({ mode: 'slots', rows: [row(1, 2, ' 22-909 '), row(3, 3, '  ')] })).toEqual({
      mode: 'slots',
      slots: [
        { weekday: 2, periodFrom: 1, periodTo: 2, classroom: '22-909' },
        { weekday: 2, periodFrom: 3, periodTo: 3, classroom: null },
      ],
    });
  });

  it('drops rows for other modes', () => {
    expect(toOverride({ mode: 'none', rows: [row(1, 1)] })).toEqual({ mode: 'none', slots: [] });
  });
});
