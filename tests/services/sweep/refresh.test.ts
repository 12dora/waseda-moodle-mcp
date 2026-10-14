import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoodleError, MoodleUnavailable, NeedsReconnect } from '../../../src/core/errors';
import { refreshSnapshots } from '../../../src/core/services/sweep/refresh';
import { buildSnapshot, parseSnapshot } from '../../../src/core/services/sweep/snapshot';
import { BASE, course, MIN, makeFake, NOW, NOW_MS, NOW_SEC, rawSection, snapshotRow } from './helpers';

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
const json = (name = 'Old') => JSON.stringify(buildSnapshot(contents(name), { baseUrl: BASE }));
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
            { id: 1, updates: [{ name: 'completion' }, { name: 'submissions' }] },
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
