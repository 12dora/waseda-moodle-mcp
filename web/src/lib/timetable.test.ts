import { describe, expect, it } from 'vitest';
import type { TimetableClass, TimetableDay } from '../api/types';
import { addDays, periodBlocks, todayJst, visibleDays, weekStart } from './timetable';

const cls = (courseId: number, periodFrom: number, periodTo: number): TimetableClass => ({
  courseId,
  courseName: `C${courseId}`,
  start: '08:50',
  end: '10:30',
  periods: `P${periodFrom}`,
  periodFrom,
  periodTo,
  night: false,
  classroom: null,
  campus: null,
  url: `https://example.com/course/view.php?id=${courseId}`,
  source: 'syllabus',
});

const day = (date: string, weekday: number, classes: TimetableClass[] = []): TimetableDay => ({
  date,
  weekday,
  notes: [],
  classes,
});

describe('dates', () => {
  it('computes JST today', () => {
    expect(todayJst(Date.parse('2026-10-15T15:30:00Z'))).toBe('2026-10-16');
    expect(todayJst(Date.parse('2026-10-15T14:59:00Z'))).toBe('2026-10-15');
  });

  it('computes week starts', () => {
    expect(weekStart('2026-10-15')).toBe('2026-10-12');
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
  });

  it('adds days across months', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-10-05', -7)).toBe('2026-09-28');
  });
});

describe('visibleDays', () => {
  it('drops an empty Sunday and keeps a Sunday with classes', () => {
    const sat = day('2026-10-17', 6);
    expect(visibleDays([sat, day('2026-10-18', 7)])).toEqual([sat]);
    const sun = day('2026-10-18', 7, [cls(1, 1, 1)]);
    expect(visibleDays([sat, sun])).toEqual([sat, sun]);
  });
});

describe('periodBlocks', () => {
  it('keeps separate periods apart', () => {
    const blocks = periodBlocks([cls(2, 3, 3), cls(1, 1, 2)]);
    expect(blocks.map((b) => [b.from, b.to, b.classes.map((c) => c.courseId)])).toEqual([
      [1, 2, [1]],
      [3, 3, [2]],
    ]);
  });

  it('merges overlapping ranges into their union', () => {
    const blocks = periodBlocks([cls(1, 1, 2), cls(2, 2, 3), cls(3, 3, 3), cls(4, 5, 5)]);
    expect(blocks.map((b) => [b.from, b.to, b.classes.map((c) => c.courseId)])).toEqual([
      [1, 3, [1, 2, 3]],
      [5, 5, [4]],
    ]);
  });

  it('stacks classes sharing the same slot', () => {
    const blocks = periodBlocks([cls(1, 4, 4), cls(2, 4, 4)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.classes).toHaveLength(2);
  });
});
