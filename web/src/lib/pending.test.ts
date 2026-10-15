import { describe, expect, it } from 'vitest';
import { PENDING_LIMIT, pendingCountText } from './pending';

describe('pendingCountText', () => {
  it('shows exact counts below the limit', () => {
    expect(pendingCountText(0)).toBe('0');
    expect(pendingCountText(3)).toBe('3');
    expect(pendingCountText(PENDING_LIMIT - 1)).toBe(String(PENDING_LIMIT - 1));
  });

  it('caps a full page as "limit+"', () => {
    expect(pendingCountText(PENDING_LIMIT)).toBe(`${PENDING_LIMIT}+`);
    expect(pendingCountText(PENDING_LIMIT + 5)).toBe(`${PENDING_LIMIT}+`);
  });
});
