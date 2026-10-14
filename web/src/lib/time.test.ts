import { describe, expect, it } from 'vitest';
import { dueGroup, formatDate, formatDateTime } from './time';

const now = Date.parse('2026-10-14T12:00:00+09:00'); // Wed
const deadline = { now, deadline: true };

describe('formatDateTime', () => {
  it('formats in each language', () => {
    const iso = '2026-10-15T23:59:00+09:00';
    expect(formatDateTime(iso, 'ja', { now })).toBe('10月15日(木) 23:59');
    expect(formatDateTime(iso, 'en', { now })).toBe('Thu, Oct 15, 23:59');
    expect(formatDateTime(iso, 'zh-CN', { now })).toBe('10月15日 周四 23:59');
  });

  it('shows a midnight deadline as previous day 24:00', () => {
    const iso = '2026-10-16T00:00:00+09:00';
    expect(formatDateTime(iso, 'ja', deadline)).toBe('10月15日(木) 24:00');
    expect(formatDateTime(iso, 'en', deadline)).toBe('Thu, Oct 15, 24:00');
  });

  it('formats midnight normally when it is not a deadline', () => {
    expect(formatDateTime('2026-10-16T00:00:00+09:00', 'ja', { now })).toBe('10月16日(金) 00:00');
  });

  it('requires zero seconds for the 24:00 rule', () => {
    expect(formatDateTime('2026-10-16T00:00:30+09:00', 'ja', deadline)).toBe('10月16日(金) 00:00');
  });

  it('handles a midnight deadline across a year boundary', () => {
    expect(formatDateTime('2027-01-01T00:00:00+09:00', 'ja', deadline)).toBe('12月31日(木) 24:00');
  });

  it('adds the year when not the current year', () => {
    expect(formatDateTime('2027-04-01T09:00:00+09:00', 'ja', { now })).toBe('2027年4月1日(木) 09:00');
    expect(formatDateTime('2027-04-01T09:00:00+09:00', 'en', { now })).toBe('Thu, Apr 1, 2027, 09:00');
  });

  it('reads UTC input as JST wall time', () => {
    expect(formatDateTime('2026-10-15T05:30:00Z', 'en', { now })).toBe('Thu, Oct 15, 14:30');
  });

  it('returns a dash for missing or invalid values', () => {
    expect(formatDateTime(null, 'en', { now })).toBe('-');
    expect(formatDateTime('nope', 'en', { now })).toBe('-');
  });
});

describe('formatDate', () => {
  it('always includes the year', () => {
    expect(formatDate('2026-10-15T10:00:00+09:00', 'ja')).toBe('2026年10月15日(木)');
    expect(formatDate('2026-10-15T10:00:00+09:00', 'en')).toBe('Thu, Oct 15, 2026');
    expect(formatDate('2026-10-15T10:00:00+09:00', 'zh-CN')).toBe('2026年10月15日 周四');
  });

  it('never applies the 24:00 rule', () => {
    expect(formatDate('2026-10-16T00:00:00+09:00', 'en')).toBe('Fri, Oct 16, 2026');
  });
});

describe('dueGroup', () => {
  it('buckets deadlines by JST day', () => {
    expect(dueGroup('2026-10-14T11:00:00+09:00', { now })).toBe('overdue');
    expect(dueGroup('2026-10-14T23:59:00+09:00', { now })).toBe('today');
    expect(dueGroup('2026-10-15T00:00:00+09:00', { now })).toBe('today'); // 14日 24:00
    expect(dueGroup('2026-10-15T00:01:00+09:00', { now })).toBe('tomorrow');
    expect(dueGroup('2026-10-16T00:00:00+09:00', { now })).toBe('tomorrow');
    expect(dueGroup('2026-10-20T23:59:00+09:00', { now })).toBe('week');
    expect(dueGroup('2026-10-21T10:00:00+09:00', { now })).toBe('later');
    expect(dueGroup(null, { now })).toBe('later');
  });

  it('keeps opening times on their own day', () => {
    expect(dueGroup('2026-10-15T00:00:00+09:00', { now, deadline: false })).toBe('tomorrow');
  });
});
