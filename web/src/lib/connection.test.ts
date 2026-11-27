import { describe, expect, it } from 'vitest';
import { lastCheckedAt } from './connection';

const EARLY = '2026-11-27T08:00:00+09:00';
const LATE = '2026-11-27T09:17:00+09:00';

describe('lastCheckedAt', () => {
  it('takes the later of the last request and the last session answer', () => {
    expect(lastCheckedAt({ lastOkAt: EARLY, sessionOkAt: LATE })).toBe(LATE);
    expect(lastCheckedAt({ lastOkAt: LATE, sessionOkAt: EARLY })).toBe(LATE);
  });

  it('takes whichever one exists', () => {
    expect(lastCheckedAt({ lastOkAt: EARLY, sessionOkAt: null })).toBe(EARLY);
    expect(lastCheckedAt({ lastOkAt: null, sessionOkAt: LATE })).toBe(LATE);
  });

  it('is null before any check', () => {
    expect(lastCheckedAt({ lastOkAt: null, sessionOkAt: null })).toBeNull();
  });
});
