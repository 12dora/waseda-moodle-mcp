import { describe, expect, it, vi } from 'vitest';
import { revalidate, revalidateInTurn } from './revalidate';

type Item = { stale: boolean; n: number };

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

describe('revalidateInTurn', () => {
  const deferred = <T>() => {
    let resolve: (v: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('runs the refreshes of a page one after another, in the order asked', async () => {
    const log: string[] = [];
    const first = deferred<{ stale: boolean; n: number }>();
    const a = revalidateInTurn<Item>(
      { stale: true, n: 1 },
      () => {
        log.push('a:start');
        return first.promise;
      },
      () => true,
    );
    const b = revalidateInTurn<Item>(
      { stale: true, n: 2 },
      async () => {
        log.push('b:start');
        return { stale: false, n: 20 };
      },
      () => true,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['a:start']); // b waits for a
    first.resolve({ stale: false, n: 10 });
    expect(await a).toEqual({ stale: false, n: 10 });
    expect(await b).toEqual({ stale: false, n: 20 });
    expect(log).toEqual(['a:start', 'b:start']);
  });

  it('a failed refresh keeps its copy and does not hold up the next one', async () => {
    const stale = { stale: true, n: 1 };
    const failed = revalidateInTurn<Item>(
      stale,
      () => Promise.reject(new Error('offline')),
      () => true,
    );
    const next = revalidateInTurn<Item>(
      { stale: true, n: 2 },
      async () => ({ stale: false, n: 3 }),
      () => true,
    );
    expect(await failed).toBe(stale);
    expect(await next).toEqual({ stale: false, n: 3 });
  });

  it('skips a refresh no longer wanted when its turn comes, and never queues a fresh answer', async () => {
    const refresh = vi.fn(async () => ({ stale: false, n: 2 }));
    let wanted = true;
    const blocker = deferred<{ stale: boolean; n: number }>();
    const head = revalidateInTurn<Item>(
      { stale: true, n: 0 },
      () => blocker.promise,
      () => true,
    );
    const gone = { stale: true, n: 1 };
    const skipped = revalidateInTurn<Item>(gone, refresh, () => wanted);
    wanted = false; // the card unmounted while waiting
    blocker.resolve({ stale: false, n: 9 });
    await head;
    expect(await skipped).toBe(gone);
    const fresh = { stale: false, n: 5 };
    expect(await revalidateInTurn(fresh, refresh, () => true)).toBe(fresh);
    expect(refresh).not.toHaveBeenCalled();
  });
});
