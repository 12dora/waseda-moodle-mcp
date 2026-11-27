import { describe, expect, it, vi } from 'vitest';
import { revalidate } from './revalidate';

describe('revalidate', () => {
  it('keeps a fresh answer and does not refresh it', async () => {
    const first = { stale: false, n: 1 };
    const refresh = vi.fn(async () => ({ stale: false, n: 2 }));
    expect(await revalidate(first, refresh)).toBe(first);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('replaces a stale answer with the refreshed one', async () => {
    const fresh = { stale: false, n: 2 };
    expect(await revalidate({ stale: true, n: 1 }, async () => fresh)).toBe(fresh);
  });

  it('keeps the stale answer when the refresh fails', async () => {
    const first = { stale: true, n: 1 };
    expect(await revalidate(first, () => Promise.reject(new Error('offline')))).toBe(first);
  });
});
