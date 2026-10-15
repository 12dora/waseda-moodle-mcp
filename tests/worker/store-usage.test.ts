import { beforeEach, describe, expect, it } from 'vitest';
import { usagePeriods } from '../../src/core/usage';
import { purgeUsage, resetUsageMemory } from '../../src/worker/store/usage';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-15T03:00:00Z'); // Thursday 12:00 JST
const P = usagePeriods(NOW);

let t: TestD1;
let store: D1Store;

beforeEach(() => {
  resetUsageMemory();
  t = createTestD1();
  store = createD1Store(t.db);
});

const call = (userId: number, client: string, tool = 'get_due_items', ok = true, now = NOW) =>
  store.recordToolCall({ userId, client, tool, ok, now });

const value = (period: string, metric: string, dim = ''): number =>
  (
    t.sqlite
      .prepare('SELECT value FROM usage_counts WHERE period = ? AND metric = ? AND dim = ?')
      .get(period, metric, dim) as { value: number } | undefined
  )?.value ?? 0;

const count = (table: string): number =>
  (t.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('recordToolCall', () => {
  it('counts calls per tool and per client, and failures per tool', async () => {
    await call(1, 'Claude');
    await call(1, 'Claude', 'get_due_items', false);
    await call(2, 'Cursor', 'list_courses');
    expect(value(P.day, 'calls', 'get_due_items')).toBe(2);
    expect(value(P.day, 'errors', 'get_due_items')).toBe(1);
    expect(value(P.day, 'calls', 'list_courses')).toBe(1);
    expect(value(P.day, 'errors', 'list_courses')).toBe(0);
    expect(value(P.day, 'client_calls', 'Claude')).toBe(2);
    expect(value(P.day, 'client_calls', 'Cursor')).toBe(1);
  });

  it('counts a user once per day, week and month however often they call', async () => {
    for (let i = 0; i < 4; i++) await call(1, 'Claude');
    for (const period of [P.day, P.week, P.month]) expect(value(period, 'active')).toBe(1);
    expect(value(P.month, 'client_active', 'Claude')).toBe(1);
    // the per-client split is only kept for the month
    expect(value(P.day, 'client_active', 'Claude')).toBe(0);
    expect(value(P.week, 'client_active', 'Claude')).toBe(0);
    expect(value(P.day, 'calls', 'get_due_items')).toBe(4);
  });

  it('de-duplicates across isolates through the stored keys', async () => {
    await call(1, 'Claude');
    resetUsageMemory(); // another isolate: no memo, no cached salt
    await call(1, 'Claude');
    expect(value(P.day, 'active')).toBe(1);
    expect(value(P.month, 'client_active', 'Claude')).toBe(1);
    expect(count('usage_salts')).toBe(3);
    expect(value(P.day, 'calls', 'get_due_items')).toBe(2);
  });

  it('counts distinct users and, per client, each user once', async () => {
    await call(1, 'Claude');
    await call(2, 'Claude');
    await call(1, 'Cursor');
    await call(1, 'Cursor');
    expect(value(P.day, 'active')).toBe(2);
    expect(value(P.month, 'active')).toBe(2);
    expect(value(P.month, 'client_active', 'Claude')).toBe(2);
    expect(value(P.month, 'client_active', 'Cursor')).toBe(1);
  });

  it('does not count again when the dedup key already exists, and counts when it is new', async () => {
    await call(1, 'Claude');
    t.sqlite.prepare("DELETE FROM usage_counts WHERE metric IN ('active', 'client_active')").run();
    resetUsageMemory();
    await call(1, 'Claude'); // keys are already stored: the counters must not move
    expect(value(P.day, 'active')).toBe(0);
    expect(value(P.month, 'client_active', 'Claude')).toBe(0);
    await call(2, 'Claude'); // a new user is counted exactly once
    expect(value(P.day, 'active')).toBe(1);
    expect(value(P.month, 'client_active', 'Claude')).toBe(1);
  });

  it('records the call, the dedup keys and their counts atomically', async () => {
    t.sqlite
      .prepare(
        `CREATE TRIGGER fail_active BEFORE INSERT ON usage_counts WHEN NEW.metric = 'active'
         BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      )
      .run();
    await expect(call(1, 'Claude')).rejects.toThrow();
    expect(count('usage_seen')).toBe(0);
    expect(value(P.day, 'calls', 'get_due_items')).toBe(0);

    t.sqlite.prepare('DROP TRIGGER fail_active').run();
    await call(1, 'Claude'); // not memoised after the failure: recorded now
    expect(value(P.day, 'active')).toBe(1);
    expect(value(P.day, 'calls', 'get_due_items')).toBe(1);
  });

  it('starts a new day and keeps the week and month', async () => {
    await call(1, 'Claude');
    const next = NOW + DAY; // Friday, same week and month
    await call(1, 'Claude', 'get_due_items', true, next);
    const n = usagePeriods(next);
    expect(value(P.day, 'active')).toBe(1);
    expect(value(n.day, 'active')).toBe(1);
    expect(value(P.week, 'active')).toBe(1);
    expect(n.week).toBe(P.week);
    expect(value(P.month, 'active')).toBe(1);
  });

  it('stores no user id: keys are truncated hashes that differ per period and metric', async () => {
    await call(1001, 'Claude');
    const keys = t.sqlite.prepare('SELECT period, key FROM usage_seen').all() as { period: string; key: string }[];
    expect(keys).toHaveLength(4); // active for day, week, month + the month's client split
    for (const k of keys) expect(k.key).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(keys.map((k) => k.key)).size).toBe(4);
  });
});

describe('purgeUsage', () => {
  it('keeps current periods and recent counters, removes ended periods and counters over 400 days', async () => {
    const old = NOW - 401 * DAY;
    const recent = NOW - 390 * DAY; // Saturday 2025-09-20: day and week (Monday 09-15) inside the window
    const op = usagePeriods(old);
    const rp = usagePeriods(recent);
    await call(1, 'Claude', 'old_tool', true, old);
    await call(1, 'Claude', 'recent_tool', true, recent);
    await call(1, 'Claude'); // current periods
    await call(2, 'Claude', 'get_due_items', true, NOW - DAY); // yesterday (Wednesday: same week and month)
    expect(count('usage_salts')).toBeGreaterThan(3);

    const res = await purgeUsage(t.db, NOW);

    // counters: the 401-day-old periods (d, w, m) are gone, the 390-day-old day and week survive
    expect(value(op.day, 'calls', 'old_tool')).toBe(0);
    expect(value(op.week, 'active')).toBe(0);
    expect(value(rp.day, 'calls', 'recent_tool')).toBe(1);
    expect(value(rp.week, 'active')).toBe(1);
    expect(value(P.day, 'calls', 'get_due_items')).toBe(1);
    expect(value(usagePeriods(NOW - DAY).day, 'calls', 'get_due_items')).toBe(1);
    expect(res.usageCounts).toBeGreaterThan(0);

    // seen keys and salts: only the current day, week and month remain
    const seenPeriods = t.sqlite.prepare('SELECT DISTINCT period FROM usage_seen ORDER BY period').all();
    expect(seenPeriods.map((r) => (r as { period: string }).period).sort()).toEqual([P.day, P.month, P.week].sort());
    const saltPeriods = t.sqlite.prepare('SELECT period FROM usage_salts').all();
    expect(saltPeriods.map((r) => (r as { period: string }).period).sort()).toEqual([P.day, P.month, P.week].sort());
    expect(res.usageSeen).toBeGreaterThan(0);
    expect(res.usageSalts).toBeGreaterThan(0);
  });

  it('judges a month by its first day and a week by its Monday', async () => {
    const insert = t.sqlite.prepare(
      "INSERT INTO usage_counts (period, metric, dim, value) VALUES (?, 'active', '', 1)",
    );
    // cutoff = 2025-09-10 (400 days before 2026-10-15)
    const periods = ['m:2025-09', 'm:2025-10', 'w:2025-09-08', 'w:2025-09-15', 'd:2025-09-09', 'd:2025-09-10'];
    for (const p of periods) insert.run(p);
    await purgeUsage(t.db, NOW);
    const left = (
      t.sqlite.prepare('SELECT period FROM usage_counts ORDER BY period').all() as { period: string }[]
    ).map((r) => r.period);
    expect(left).toEqual(['d:2025-09-10', 'm:2025-10', 'w:2025-09-15']);
  });

  it('runs as part of the daily purge', async () => {
    t.sqlite.prepare("INSERT INTO usage_salts (period, salt) VALUES ('d:2020-01-01', 'x')").run();
    const res = await store.purgeExpired(NOW);
    expect(res).toMatchObject({ usageSalts: 1 });
    expect(count('usage_salts')).toBe(0);
  });
});
