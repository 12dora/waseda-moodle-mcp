import { describe, expect, it } from 'vitest';
import type { UsageStats } from '../api/types';
import {
  barPath,
  barSlots,
  DEFAULT_STATS_RANGE,
  failureRate,
  formatRate,
  hasUsage,
  niceScale,
  parseStatsRange,
  peakOf,
  sharePercent,
  shortDay,
  sumOf,
  xTickIndexes,
} from './stats';

const empty = (): UsageStats => ({
  generatedAt: 0,
  days: 7,
  users: { total: 0, newInRange: 0, activeToday: 0, activeWeek: 0, activeMonth: 0 },
  daily: [{ day: '2026-10-15', active: 0, calls: 0, errors: 0, newUsers: 0 }],
  tools: [],
  clients: [],
});

describe('parseStatsRange', () => {
  it('accepts 7 / 30 / 90', () => {
    expect(parseStatsRange('7')).toBe(7);
    expect(parseStatsRange('30')).toBe(30);
    expect(parseStatsRange('90')).toBe(90);
  });

  it('falls back to the default', () => {
    expect(DEFAULT_STATS_RANGE).toBe(30);
    for (const v of [null, undefined, '', '14', 'abc', '7.5', '-7', '07', '7.0', ' 7', '7 ', '1e1', '90x', '0x1e']) {
      expect(parseStatsRange(v)).toBe(30);
    }
  });
});

describe('niceScale', () => {
  it('rounds the peak up to a 1/2/5 step with at most 4 steps', () => {
    expect(niceScale(12)).toEqual({ max: 15, ticks: [0, 5, 10, 15] });
    expect(niceScale(340)).toEqual({ max: 400, ticks: [0, 100, 200, 300, 400] });
    expect(niceScale(101)).toEqual({ max: 150, ticks: [0, 50, 100, 150] });
    expect(niceScale(4)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
  });

  it('never uses fractional steps for small counts', () => {
    expect(niceScale(1)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
  });

  it('keeps a usable axis when everything is zero', () => {
    expect(niceScale(0)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
  });

  it('always covers the peak within maxTicks steps', () => {
    for (const peak of [1, 2, 5, 7, 9, 11, 19, 23, 99, 999, 1234, 98765]) {
      const s = niceScale(peak);
      expect(s.max).toBeGreaterThanOrEqual(peak);
      expect(s.ticks.length - 1).toBeLessThanOrEqual(4);
      expect(s.ticks.at(-1)).toBe(s.max);
    }
  });
});

describe('xTickIndexes', () => {
  it('picks first, middle and last', () => {
    expect(xTickIndexes(30)).toEqual([0, 14, 29]);
    expect(xTickIndexes(7)).toEqual([0, 3, 6]);
  });

  it('deduplicates short series', () => {
    expect(xTickIndexes(0)).toEqual([]);
    expect(xTickIndexes(1)).toEqual([0]);
    expect(xTickIndexes(2)).toEqual([0, 1]);
  });
});

describe('shortDay', () => {
  it('formats M/D without leading zeros', () => {
    expect(shortDay('2026-10-15')).toBe('10/15');
    expect(shortDay('2026-01-05')).toBe('1/5');
  });
});

describe('sharePercent', () => {
  it('scales to 0–100', () => {
    expect(sharePercent(5, 10)).toBe(50);
    expect(sharePercent(10, 10)).toBe(100);
    expect(sharePercent(0, 10)).toBe(0);
    expect(sharePercent(3, 0)).toBe(0);
    expect(sharePercent(20, 10)).toBe(100);
  });
});

describe('failure rate', () => {
  it('is null without calls', () => {
    expect(failureRate(0, 0)).toBeNull();
    expect(formatRate(null, 'en')).toBe('—');
  });

  it('formats one decimal percent', () => {
    expect(formatRate(failureRate(340, 3), 'en')).toBe('0.9%');
    expect(formatRate(failureRate(10, 0), 'ja')).toBe('0.0%');
    expect(formatRate(failureRate(8, 1), 'zh-CN')).toBe('12.5%');
  });
});

describe('peakOf / sumOf', () => {
  it('handles empty input', () => {
    expect(peakOf([])).toBe(0);
    expect(sumOf([])).toBe(0);
    expect(peakOf([3, 9, 2])).toBe(9);
    expect(sumOf([3, 9, 2])).toBe(14);
  });
});

describe('hasUsage', () => {
  it('is false when every count is zero', () => {
    expect(hasUsage(empty())).toBe(false);
  });

  it('ignores user counts on their own (fresh instance)', () => {
    const a = empty();
    a.users = { total: 3, newInRange: 3, activeToday: 0, activeWeek: 0, activeMonth: 0 };
    a.daily[0] = { day: '2026-10-15', active: 0, calls: 0, errors: 0, newUsers: 3 };
    expect(hasUsage(a)).toBe(false);
  });

  it('is true once any tool call or active user was recorded', () => {
    const a = empty();
    a.daily[0] = { day: '2026-10-15', active: 1, calls: 0, errors: 0, newUsers: 0 };
    expect(hasUsage(a)).toBe(true);
    const t = empty();
    t.tools.push({ name: 'list_courses', calls: 1, errors: 0 });
    expect(hasUsage(t)).toBe(true);
    const b = empty();
    b.daily[0] = { day: '2026-10-15', active: 0, calls: 2, errors: 0, newUsers: 0 };
    expect(hasUsage(b)).toBe(true);
    const c = empty();
    c.clients.push({ name: 'Other', calls: 0, activeMonth: 1 });
    expect(hasUsage(c)).toBe(true);
  });
});

describe('barSlots', () => {
  it('uses 2px gaps when there is room', () => {
    expect(barSlots(30, 600)).toEqual({ slot: 20, bar: 18 });
  });

  it('narrows the gap for dense series', () => {
    expect(barSlots(90, 300)).toEqual({ slot: 300 / 90, bar: 300 / 90 - 1 });
    expect(barSlots(90, 180)).toEqual({ slot: 2, bar: 2 });
  });

  it('handles empty input', () => {
    expect(barSlots(0, 600)).toEqual({ slot: 0, bar: 0 });
    expect(barSlots(7, 0)).toEqual({ slot: 0, bar: 0 });
  });
});

describe('barPath', () => {
  it('rounds only the top corners', () => {
    expect(barPath(10, 100, 18, 50)).toBe('M10 100 V54 A4 4 0 0 1 14 50 H24 A4 4 0 0 1 28 54 V100 Z');
  });

  it('caps the radius by width and height', () => {
    expect(barPath(0, 10, 2, 1)).toBe('M0 10 V10 A1 1 0 0 1 1 9 H1 A1 1 0 0 1 2 10 V10 Z');
  });

  it('draws nothing for zero bars', () => {
    expect(barPath(0, 10, 4, 0)).toBe('');
  });
});
