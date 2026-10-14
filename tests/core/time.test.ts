import { describe, expect, it } from 'vitest';
import { deadlineMs, fmt, fmtDue } from '../../src/core/time';

describe('fmt / fmtDue', () => {
  it('fmt is plain: 00:00 stays 00:00', () => {
    expect(fmt('2026-10-15T00:00:00+09:00')).toBe('2026-10-15 Thu 00:00');
    expect(fmt('2026-10-15T23:59:00+09:00')).toBe('2026-10-15 Thu 23:59');
    expect(fmt(null)).toBe('-');
  });

  it('fmtDue shows a midnight deadline as the previous day 24:00', () => {
    expect(fmtDue('2026-10-15T00:00:00+09:00')).toBe('2026-10-14 Wed 24:00');
    expect(fmtDue('2026-10-15T00:01:00+09:00')).toBe('2026-10-15 Thu 00:01');
    expect(fmtDue('2026-10-15T23:59:00+09:00')).toBe('2026-10-15 Thu 23:59');
    expect(fmtDue(undefined)).toBe('-');
  });

  it('deadlineMs moves a midnight deadline into the previous day', () => {
    const midnight = Date.parse('2026-10-15T00:00:00+09:00');
    expect(deadlineMs('2026-10-15T00:00:00+09:00')).toBe(midnight - 1);
    expect(deadlineMs('2026-10-15T09:00:00+09:00')).toBe(Date.parse('2026-10-15T09:00:00+09:00'));
  });
});
