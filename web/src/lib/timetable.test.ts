import { describe, expect, it } from 'vitest';
import { addDays, isoWeekday, periodSpan, todayJst, weekStart } from './timetable';

describe('dates', () => {
  it('computes JST today', () => {
    expect(todayJst(Date.parse('2026-10-15T15:30:00Z'))).toBe('2026-10-16');
    expect(todayJst(Date.parse('2026-10-15T14:59:00Z'))).toBe('2026-10-15');
  });

  it('computes weekdays and week starts', () => {
    expect(isoWeekday('2026-10-15')).toBe(4); // Thu
    expect(isoWeekday('2026-10-18')).toBe(7); // Sun
    expect(weekStart('2026-10-15')).toBe('2026-10-12');
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
  });

  it('adds days across months', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-10-05', -7)).toBe('2026-09-28');
  });
});

describe('periodSpan', () => {
  it('maps official periods', () => {
    expect(periodSpan('08:50', '10:30')).toEqual({ from: 1, to: 1 });
    expect(periodSpan('08:50', '12:20')).toEqual({ from: 1, to: 2 });
    expect(periodSpan('20:45', '21:35')).toEqual({ from: 7, to: 7 });
  });

  it('maps WBS night times onto periods 6 and 7', () => {
    expect(periodSpan('18:30', '20:10')).toEqual({ from: 6, to: 6 });
    expect(periodSpan('20:20', '22:00')).toEqual({ from: 7, to: 7 });
  });
});
