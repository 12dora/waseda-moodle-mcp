import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoodleError, MoodleUnavailable, NeedsReconnect } from '../../../src/core/errors';
import { loadStoredSnapshots, refreshSnapshots } from '../../../src/core/services/sweep/refresh';
import { buildSnapshot, parseSnapshot } from '../../../src/core/services/sweep/snapshot';
import { BASE, course, DAY, MIN, makeFake, NOW, NOW_MS, NOW_SEC, rawSection, snapshotRow } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const CONTENTS = 'core_course_get_contents';
const UPDATES = 'core_course_get_updates_since';
const OPTS = { maxCalls: 12, maxFull: 3 };

const contents = (extraName = 'Old') => [rawSection(1, [{ id: 1, modname: 'resource', name: extraName }])];
const json = (name = 'Old') => JSON.stringify(buildSnapshot(contents(name), { baseUrl: BASE, now: NOW_MS }));
const courses = (n: number) => Array.from({ length: n }, (_, i) => course(100 + i));

describe('refreshSnapshots', () => {
  it('fetches missing courses up to maxFull and reports the rest as stale', async () => {
    const f = makeFake({ [CONTENTS]: () => contents() });
    const r = await refreshSnapshots(f.ctx, courses(5), OPTS);
    expect(f.calls).toHaveLength(3);
    expect(f.puts).toHaveLength(3);
    expect(r.refreshed).toBe(3);
    expect(r.snapshots.size).toBe(3);
    expect(r.stats).toEqual({ checked: 3, stale: 2, checkedAt: '2026-10-14T12:00:00+09:00' });
    // stored row is parseable and stamped as checked now
    expect(parseSnapshot(f.rows.get(100)?.json ?? '')?.s[0]?.m[0]?.n).toBe('Old');
    expect(f.rows.get(100)).toMatchObject({ fetchedAt: NOW_MS, checkedAt: NOW_MS });
  });

  it('does nothing for fresh snapshots (< 30 min)', async () => {
    const f = makeFake({}, [snapshotRow(100, json(), NOW_MS - 29 * MIN)]);
    const r = await refreshSnapshots(f.ctx, [course(100)], OPTS);
    expect(f.calls).toEqual([]);
    expect(r.stats).toEqual({ checked: 1, stale: 0, checkedAt: '2026-10-14T11:31:00+09:00' });
  });

  it('stale + no relevant update → touch only (since = checkedAt - 300 s)', async () => {
    const f = makeFake(
      {
        [UPDATES]: () => ({
          instances: [
            { id: 1, updates: [{ name: 'comments' }, { name: 'gradeitems' }] },
            { id: 1000, updates: [] },
          ],
        }),
      },
      [snapshotRow(100, json(), NOW_MS - 40 * MIN)],
    );
    const r = await refreshSnapshots(f.ctx, [course(100)], OPTS);
    expect(f.calls).toEqual([
      { fn: UPDATES, params: { courseid: 100, since: Math.floor((NOW_MS - 40 * MIN) / 1000) - 300 } },
    ]);
    expect(f.touched).toEqual([100]);
    expect(f.puts).toEqual([]);
    expect(r.stats.checked).toBe(1);
  });

  it.each([
    ['configuration on a known module', [{ id: 1, updates: [{ name: 'configuration' }] }]],
    ['contentfiles on a known module', [{ id: 1, updates: [{ name: 'contentfiles' }] }]],
    ['an unknown cmid', [{ id: 77, updates: [{ name: 'completion' }] }]],
  ])('stale + %s → full refetch with diff', async (_n, instances) => {
    const f = makeFake({ [UPDATES]: () => ({ instances }), [CONTENTS]: () => contents('New') }, [
      snapshotRow(100, json(), NOW_MS - 40 * MIN),
    ]);
    const r = await refreshSnapshots(f.ctx, [course(100)], OPTS);
    expect(f.calls.map((c) => c.fn)).toEqual([UPDATES, CONTENTS]);
    expect(f.touched).toEqual([]);
    expect(r.refreshed).toBe(1);
    const mod = parseSnapshot(f.rows.get(100)?.json ?? '')?.s[0]?.m[0];
    expect(mod).toMatchObject({ n: 'New', a: NOW_MS });
    expect(mod?.w).toContain('configuration');
  });

  it('falls back to a refetch when updates_since errors', async () => {
    const f = makeFake(
      {
        [UPDATES]: () => {
          throw new MoodleError('nope', 'accessexception');
        },
        [CONTENTS]: () => contents('New'),
      },
      [snapshotRow(100, json(), NOW_MS - 40 * MIN)],
    );
    const r = await refreshSnapshots(f.ctx, [course(100)], OPTS);
    expect(r.refreshed).toBe(1);
  });

  it('respects the call and refetch budgets; missing courses first, then oldest checked', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => snapshotRow(200 + i, json(), NOW_MS - (40 + i) * MIN));
    const f = makeFake(
      {
        [UPDATES]: () => ({ instances: [{ id: 1, updates: [{ name: 'configuration' }] }] }),
        [CONTENTS]: () => contents(),
      },
      rows,
    );
    const targets = [course(100), ...Array.from({ length: 10 }, (_, i) => course(200 + i))];
    const r = await refreshSnapshots(f.ctx, targets, OPTS);
    expect(f.calls.length).toBeLessThanOrEqual(12);
    expect(f.calls[0]).toMatchObject({ fn: CONTENTS, params: { courseid: 100 } }); // the missing course comes first
    expect(f.calls.filter((c) => c.fn === CONTENTS)).toHaveLength(3);
    expect(r.refreshed).toBe(3);
    const checked = f.calls.filter((c) => c.fn === UPDATES).map((c) => c.params.courseid);
    expect(checked).toHaveLength(9); // 12 calls - 1 fetch - 2 kept for the refetches the checks may trigger
    expect(checked[0]).toBe(209); // oldest first
    expect(r.stats.stale).toBeGreaterThan(0);
  });

  it('a failing course stays stale; the others are refreshed', async () => {
    const f = makeFake({
      [CONTENTS]: (p) => {
        if (p.courseid === 100) throw new MoodleUnavailable();
        return contents();
      },
    });
    const r = await refreshSnapshots(f.ctx, courses(2), OPTS);
    expect(r.snapshots.has(100)).toBe(false);
    expect(r.snapshots.has(101)).toBe(true);
    expect(r.stats).toMatchObject({ checked: 1, stale: 1 });
  });

  it('serves a stale snapshot when its check fails, and ignores unreadable rows', async () => {
    const f = makeFake(
      {
        [UPDATES]: () => {
          throw new MoodleUnavailable();
        },
        [CONTENTS]: () => contents(),
      },
      [snapshotRow(100, json(), NOW_MS - 90 * MIN), snapshotRow(101, '{bad', NOW_MS)],
    );
    const r = await refreshSnapshots(f.ctx, courses(2), OPTS);
    expect(r.snapshots.has(100)).toBe(true);
    expect(r.stats).toMatchObject({ checked: 1, stale: 1 });
    expect(r.refreshed).toBe(1); // 101 was refetched
  });

  it('propagates NeedsReconnect', async () => {
    const f = makeFake({
      [CONTENTS]: () => {
        throw new NeedsReconnect();
      },
    });
    await expect(refreshSnapshots(f.ctx, courses(1), OPTS)).rejects.toBeInstanceOf(NeedsReconnect);
  });

  it('new modules after a refetch are stamped as first seen now', async () => {
    const f = makeFake(
      {
        [UPDATES]: () => ({ instances: [{ id: 2, updates: [{ name: 'configuration' }] }] }),
        [CONTENTS]: () => [
          rawSection(1, [
            { id: 1, modname: 'resource', name: 'Old' },
            { id: 2, modname: 'assign', name: 'Fresh' },
          ]),
        ],
      },
      [snapshotRow(100, json(), NOW_MS - 40 * MIN)],
    );
    await refreshSnapshots(f.ctx, [course(100)], OPTS);
    const mods = parseSnapshot(f.rows.get(100)?.json ?? '')?.s[0]?.m ?? [];
    expect(mods[1]).toMatchObject({ c: 2, s: NOW_MS });
    expect(mods[0]?.s).toBeUndefined();
    expect(NOW_SEC).toBeGreaterThan(0);
  });
});

describe('refreshSnapshots: large courses and aged snapshots', () => {
  const LARGE_Z = 200_000;
  const AGE = 24 * 60 * MIN;
  const largeJson = () => {
    const snap = buildSnapshot(contents(), { baseUrl: BASE, now: NOW_MS });
    snap.z = LARGE_Z;
    return JSON.stringify(snap);
  };
  const agedRow = (id: number) => ({
    ...snapshotRow(id, largeJson(), NOW_MS - 2 * MIN),
    fetchedAt: NOW_MS - 25 * 60 * MIN,
  });

  it('uses no large slot for a fetch that the call budget does not allow', async () => {
    const f = makeFake({ [CONTENTS]: () => contents() }, [agedRow(101)]);
    const r = await refreshSnapshots(f.ctx, [course(100), course(101)], {
      maxCalls: 1,
      maxFull: 3,
      maxLarge: 1,
      maxAgeMs: AGE,
    });
    expect(f.calls).toEqual([{ fn: CONTENTS, params: { courseid: 100 } }]); // the missing course took the only call
    expect(r.refreshed).toBe(1);
    expect(r.large).toBe(0);
  });

  it('counts a large refetch once and reports it', async () => {
    const f = makeFake({ [CONTENTS]: () => contents() }, [agedRow(100)]);
    const r = await refreshSnapshots(f.ctx, [course(100)], { ...OPTS, maxAgeMs: AGE });
    expect(r.refreshed).toBe(1);
    expect(r.large).toBe(1);
  });

  it('gives an aged course no refetch when the large slots are gone, but still checks it for changes', async () => {
    const f = makeFake({ [UPDATES]: () => ({ instances: [] }) }, [agedRow(100)]);
    const r = await refreshSnapshots(f.ctx, [course(100)], { ...OPTS, maxLarge: 0, maxAgeMs: AGE });
    expect(f.calls.map((c) => c.fn)).toEqual([UPDATES]);
    expect(f.touched).toEqual([100]);
    expect(r.snapshots.has(100)).toBe(true);
    expect(r.large).toBe(0);
  });

  it('keeps serving an aged course whose change check asks for a refetch it cannot do', async () => {
    const f = makeFake({ [UPDATES]: () => ({ instances: [{ id: 1, updates: [{ name: 'configuration' }] }] }) }, [
      agedRow(100),
    ]);
    const r = await refreshSnapshots(f.ctx, [course(100)], { ...OPTS, maxLarge: 0, maxAgeMs: AGE });
    expect(f.calls.map((c) => c.fn)).toEqual([UPDATES]);
    expect(r.refreshed).toBe(0);
    expect(r.snapshots.has(100)).toBe(true);
  });

  it('does not check an aged course whose refetch merely failed', async () => {
    const f = makeFake(
      {
        [CONTENTS]: () => {
          throw new MoodleUnavailable();
        },
      },
      [agedRow(100)],
    );
    await refreshSnapshots(f.ctx, [course(100)], { ...OPTS, maxLarge: 1, maxAgeMs: AGE });
    expect(f.calls.map((c) => c.fn)).toEqual([CONTENTS]);
  });

  it('measures a course without a known size on arrival and charges it to the large budget', async () => {
    const big = [rawSection(1, [{ id: 1, modname: 'page', name: 'Big', description: 'x'.repeat(120_000) }])];
    const f = makeFake({ [CONTENTS]: () => big });
    const r = await refreshSnapshots(f.ctx, [course(100)], { ...OPTS, maxLarge: 1 });
    expect(r.refreshed).toBe(1);
    expect(r.large).toBe(1);
    expect(parseSnapshot(f.rows.get(100)?.json ?? '')?.z).toBeGreaterThan(100_000);
    // next time it is a known large course: with no slot left it is not refetched
    const stored = f.rows.get(100) ?? snapshotRow(100, '', 0);
    const again = makeFake({ [CONTENTS]: () => big, [UPDATES]: () => ({ instances: [] }) }, [
      { ...stored, fetchedAt: NOW_MS - 2 * DAY },
    ]);
    const second = await refreshSnapshots(again.ctx, [course(100)], { ...OPTS, maxLarge: 0 });
    expect(again.calls.filter((c) => c.fn === CONTENTS)).toEqual([]);
    expect(second.large).toBe(0);
  });

  it('with unknownIsLarge, never-fetched courses share the large allowance: one fetch, the rest wait', async () => {
    const f = makeFake({ [CONTENTS]: () => contents() });
    const r = await refreshSnapshots(f.ctx, [course(100), course(101), course(102)], {
      ...OPTS,
      maxLarge: 1,
      unknownIsLarge: true,
    });
    expect(f.calls.filter((c) => c.fn === CONTENTS)).toHaveLength(1);
    expect(r.refreshed).toBe(1);
    expect(r.large).toBe(1);
    expect(r.snapshots.size).toBe(1);
  });

  it('with unknownIsLarge and no large slot left, a never-fetched course is not fetched at all', async () => {
    const f = makeFake({ [CONTENTS]: () => contents() });
    const r = await refreshSnapshots(f.ctx, [course(100)], { ...OPTS, maxLarge: 0, unknownIsLarge: true });
    expect(f.calls).toEqual([]);
    expect(r.refreshed).toBe(0);
    expect(r.large).toBe(0);
  });

  it('with unknownIsLarge, a known small course still refetches without a large slot', async () => {
    const f = makeFake({ [CONTENTS]: () => contents() }, [snapshotRow(100, json(), 0)]);
    const r = await refreshSnapshots(f.ctx, [course(100)], {
      ...OPTS,
      maxLarge: 0,
      unknownIsLarge: true,
      maxAgeMs: 24 * 60 * MIN,
    });
    expect(r.refreshed).toBe(1);
    expect(r.large).toBe(0);
  });

  it('keeps the tally current so a caller knows the large fetches when the refresh throws', async () => {
    const big = [rawSection(1, [{ id: 1, modname: 'page', name: 'Big', description: 'x'.repeat(120_000) }])];
    const f = makeFake({
      [CONTENTS]: (p) => {
        if (p.courseid === 101) throw new Error('boom');
        return big;
      },
    });
    const tally = { large: 0 };
    await expect(
      refreshSnapshots(f.ctx, [course(100), course(101)], { ...OPTS, maxLarge: 2, unknownIsLarge: true, tally }),
    ).rejects.toThrow('boom');
    expect(tally.large).toBe(2);
  });
});

describe('refreshSnapshots: remembered scope', () => {
  it('stores the sorted course ids of an interactive call once, not again while they are unchanged', async () => {
    const f = makeFake({ [CONTENTS]: () => contents() });
    await refreshSnapshots(f.ctx, [course(102), course(100)], OPTS);
    await refreshSnapshots(f.ctx, [course(100), course(102)], OPTS);
    expect(f.scopeWrites).toEqual([[100, 102]]);
    expect(f.ctx.user.scopeCourseIds).toEqual([100, 102]);
    await refreshSnapshots(f.ctx, [course(100)], OPTS);
    expect(f.scopeWrites).toEqual([[100, 102], [100]]);
  });

  it('records the scope even when every snapshot is fresh', async () => {
    const f = makeFake({}, [snapshotRow(100, json(), NOW_MS - MIN)]);
    await refreshSnapshots(f.ctx, [course(100)], OPTS);
    expect(f.scopeWrites).toEqual([[100]]);
  });

  it('reads snapshot rows once per request for a stored load and a cached refresh', async () => {
    const f = makeFake({}, [snapshotRow(100, json(), NOW_MS - MIN)]);
    const spy = vi.spyOn(f.ctx.store, 'getCourseSnapshots');
    await Promise.all([
      loadStoredSnapshots(f.ctx, [course(100)]),
      refreshSnapshots(f.ctx, [course(100)], { maxCalls: 0, maxFull: 0, rememberScope: false }),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves the scope alone when the caller opts out (the cron, one-course calls)', async () => {
    const f = makeFake({ [CONTENTS]: () => contents() });
    await refreshSnapshots(f.ctx, [course(100)], { ...OPTS, rememberScope: false });
    expect(f.scopeWrites).toEqual([]);
  });

  it('survives a failing store write', async () => {
    const f = makeFake({ [CONTENTS]: () => contents() });
    vi.spyOn(f.ctx.store, 'setScopeCourseIds').mockRejectedValue(new Error('d1 down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await refreshSnapshots(f.ctx, [course(100)], OPTS);
    expect(r.refreshed).toBe(1);
    expect(err).toHaveBeenCalledWith('scope remember failed');
    err.mockRestore();
  });
});
