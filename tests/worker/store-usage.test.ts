import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionRow, ServiceContext } from '../../src/core/context';
import { cancelAction } from '../../src/core/services/actions';
import { type FailureClass, jstWeekStart, usagePeriods } from '../../src/core/usage';
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

/** Signed up four weeks before NOW (so a call at NOW is a 4-week return). */
const SIGNUP = NOW - 28 * DAY;

const call = (userId: number, client: string, tool = 'get_due_items', ok = true, now = NOW) =>
  store.recordToolCall({
    userId,
    createdAt: SIGNUP,
    client,
    tool,
    ms: 200,
    failure: ok ? null : 'other',
    now,
  });

const web = (userId: number, feature = 'due', now = NOW, createdAt = SIGNUP) =>
  store.recordWebRequest({ userId, createdAt, feature, now });

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
    expect(keys).toHaveLength(7); // MCP and cross-channel actives for day, week, month + the month's client split
    for (const k of keys) expect(k.key).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(keys.map((k) => k.key)).size).toBe(7);
    const dims = t.sqlite.prepare('SELECT DISTINCT dim FROM usage_counts').all() as { dim: string }[];
    for (const d of dims) expect(d.dim).not.toContain('1001');
  });
});

describe('finer tool-call counters', () => {
  it('counts failures per tool by class, wall-time buckets and the JST hour', async () => {
    const at = (ms: number, failure: FailureClass | null, tool = 'get_grades') =>
      store.recordToolCall({ userId: 1, createdAt: SIGNUP, client: 'Claude', tool, ms, failure, now: NOW });
    await at(999, null);
    await at(1000, 'needs_reconnect');
    await at(2999, 'needs_reconnect');
    await at(3000, 'budget');
    await at(10_000, null, 'list_courses');
    expect(value(P.day, 'failure', 'get_grades|needs_reconnect')).toBe(2);
    expect(value(P.day, 'failure', 'get_grades|budget')).toBe(1);
    expect(value(P.day, 'errors', 'get_grades')).toBe(3);
    expect(value(P.day, 'latency', 'get_grades|lt1s')).toBe(1);
    expect(value(P.day, 'latency', 'get_grades|1to3s')).toBe(2);
    expect(value(P.day, 'latency', 'get_grades|3to10s')).toBe(1);
    expect(value(P.day, 'latency', 'list_courses|gt10s')).toBe(1);
    expect(value(P.day, 'hour_mcp', '12')).toBe(5); // 03:00 UTC = 12:00 JST
    expect(value(P.day, 'hour_web', '12')).toBe(0);
  });
});

describe('channels', () => {
  it('counts console requests per feature and hour as web activity, never as MCP activity', async () => {
    await web(1, 'due');
    await web(1, 'due');
    await web(1, 'approvals');
    expect(value(P.day, 'page', 'due')).toBe(2);
    expect(value(P.day, 'page', 'approvals')).toBe(1);
    expect(value(P.day, 'hour_web', '12')).toBe(3);
    for (const period of [P.day, P.week, P.month]) {
      expect(value(period, 'active_web')).toBe(1);
      expect(value(period, 'active_all')).toBe(1);
      expect(value(period, 'active')).toBe(0);
    }
    expect(value(P.day, 'calls', 'due')).toBe(0);
  });

  it('counts a person who uses both channels once in the cross-channel total, also across isolates', async () => {
    await call(1, 'Claude');
    await web(1);
    resetUsageMemory();
    await web(1);
    await call(1, 'Cursor');
    await web(2); // console only
    for (const period of [P.day, P.week, P.month]) {
      expect(value(period, 'active')).toBe(1);
      expect(value(period, 'active_web')).toBe(2);
      expect(value(period, 'active_all')).toBe(2);
    }
  });

  it('counts calendar feed fetches and distinct feeds per day, never as activity', async () => {
    await store.recordFeedFetch({ ownerId: 1, now: NOW });
    await store.recordFeedFetch({ ownerId: 1, now: NOW });
    resetUsageMemory();
    await store.recordFeedFetch({ ownerId: 1, now: NOW });
    await store.recordFeedFetch({ ownerId: 2, now: NOW });
    expect(value(P.day, 'ics_fetches')).toBe(4);
    expect(value(P.day, 'ics_feeds')).toBe(2);
    for (const metric of ['active', 'active_web', 'active_all']) expect(value(P.day, metric)).toBe(0);
  });

  it('records plain day counters', async () => {
    await store.recordCounts(NOW, [
      { metric: 'connect', dim: 'paste' },
      { metric: 'connect', dim: 'paste' },
      { metric: 'renew_failed', dim: 'unavailable' },
    ]);
    await store.recordCounts(NOW, []);
    expect(value(P.day, 'connect', 'paste')).toBe(2);
    expect(value(P.day, 'renew_failed', 'unavailable')).toBe(1);
  });
});

describe('retention cohorts', () => {
  const cohort = (createdAt: number) => `w:${jstWeekStart(createdAt)}`;

  it('bumps the signup week once when a user is first active 1, 2 or 4 weeks later, on any channel', async () => {
    const oneWeek = NOW - 7 * DAY;
    await web(1, 'due', NOW, oneWeek);
    await call(3, 'Claude'); // SIGNUP cohort: 4 weeks
    await store.recordToolCall({
      userId: 2,
      createdAt: oneWeek,
      client: 'Claude',
      tool: 'get_due_items',
      ms: 1,
      failure: null,
      now: NOW,
    });
    resetUsageMemory();
    await web(1, 'courses', NOW + DAY, oneWeek); // same week again: no second count
    expect(value(cohort(oneWeek), 'retained', '1')).toBe(2);
    expect(value(cohort(SIGNUP), 'retained', '4')).toBe(1);
  });

  it('ignores the signup week itself and offsets other than 1, 2 and 4', async () => {
    await web(1, 'due', NOW, NOW - DAY); // Wednesday signup, Thursday visit: week 0
    await web(2, 'due', NOW, NOW - 21 * DAY); // week 3
    await web(3, 'due', NOW, NOW - 14 * DAY); // week 2
    const rows = t.sqlite.prepare("SELECT period, dim, value FROM usage_counts WHERE metric = 'retained'").all();
    expect(rows).toEqual([{ period: cohort(NOW - 14 * DAY), dim: '2', value: 1 }]);
  });
});

describe('write funnel', () => {
  let userId: number;
  const action = (id: string, kind: ActionRow['kind'], expiresAt = NOW + 600_000): ActionRow => ({
    id,
    userId,
    kind,
    status: 'pending',
    approval: 'chat',
    title: 'Post to the forum',
    details: [],
    warnings: [],
    payload: {},
    target: null,
    source: 'Claude',
    createdAt: NOW,
    expiresAt,
    executedAt: null,
    result: null,
    error: null,
  });
  const funnel = (event: string, kind: string): number =>
    (
      t.sqlite
        .prepare('SELECT SUM(value) AS n FROM usage_counts WHERE metric = ? AND dim = ?')
        .get(`action_${event}`, kind) as { n: number | null }
    ).n ?? 0;

  beforeEach(async () => {
    userId = (await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' })).id;
  });

  it('counts prepared, executed, failed and cancelled per kind, each final status once', async () => {
    for (const id of ['a1', 'a2', 'a3', 'a4']) await store.createAction(action(id, 'forum_reply'));
    await store.createAction(action('m1', 'message'));
    expect(funnel('prepared', 'forum_reply')).toBe(4);
    expect(funnel('prepared', 'message')).toBe(1);

    for (const id of ['a1', 'a2', 'a4']) expect(await store.claimAction(id, userId, NOW)).toBe(true);
    expect(await store.updateAction('a1', { status: 'executed', executedAt: NOW, result: 'Posted.' })).toBe(true);
    expect(await store.updateAction('a1', { status: 'executed', executedAt: NOW, result: 'Again' })).toBe(false);
    expect(await store.updateAction('a2', { status: 'failed', executedAt: NOW, error: 'Moodle refused.' })).toBe(true);
    expect(await store.updateAction('a3', { status: 'cancelled' })).toBe(true);
    expect(await store.updateAction('a4', { status: 'pending' })).toBe(true); // handed back: not a funnel step
    expect(funnel('executed', 'forum_reply')).toBe(1);
    expect(funnel('failed', 'forum_reply')).toBe(1);
    expect(funnel('cancelled', 'forum_reply')).toBe(1);
    expect(funnel('executed', 'message')).toBe(0);
    expect((await store.getAction('a1'))?.result).toBe('Posted.');
  });

  it('lets exactly one of a confirm and a cancel win, and counts only that outcome', async () => {
    await store.createAction(action('r1', 'message'));
    await store.createAction(action('r2', 'message'));
    // r1: the confirm claims first; the cancel (which read it as pending) and a cancel-then-execute both lose
    expect(await store.claimAction('r1', userId, NOW)).toBe(true);
    expect(await store.updateAction('r1', { status: 'cancelled' })).toBe(false);
    expect(await store.updateAction('r1', { status: 'executed', executedAt: NOW })).toBe(true);
    expect(await store.updateAction('r1', { status: 'cancelled' })).toBe(false);
    // r2: the cancel lands first; the confirm cannot claim, a stray outcome cannot land
    expect(await store.updateAction('r2', { status: 'cancelled' })).toBe(true);
    expect(await store.claimAction('r2', userId, NOW)).toBe(false);
    expect(await store.updateAction('r2', { status: 'executed', executedAt: NOW })).toBe(false);
    expect((await store.getAction('r1'))?.status).toBe('executed');
    expect((await store.getAction('r2'))?.status).toBe('cancelled');
    expect(funnel('executed', 'message')).toBe(1);
    expect(funnel('cancelled', 'message')).toBe(1);
  });

  it('counts an expiry a list discovers, once, in one batch however many rows', async () => {
    for (const id of ['x1', 'x2', 'x3']) await store.createAction(action(id, 'message', Date.now() - 1));
    await store.createAction(action('x4', 'completion', Date.now() + 600_000));
    const statements = vi.spyOn(t.db, 'batch');
    const pending = await store.listActions(userId, { status: 'pending', limit: 50 });
    expect(pending.map((a) => a.id)).toEqual(['x4']);
    expect(statements).toHaveBeenCalledTimes(1); // expire + count + read: one round trip
    expect((await store.listActions(userId, { status: 'expired', limit: 50 })).map((a) => a.id).sort()).toEqual([
      'x1',
      'x2',
      'x3',
    ]);
    await store.purgeExpired(Date.now());
    expect(funnel('expired', 'message')).toBe(3);
    expect(funnel('expired', 'completion')).toBe(0);
    statements.mockRestore();
  });

  it('counts a cancel of an elapsed action as its expiry, once: no cancellation, nothing more at the purge', async () => {
    await store.createAction(action('c1', 'message', Date.now() - 1));
    const ctx = { user: { id: userId }, store, source: 'Claude' } as unknown as ServiceContext;
    expect(await cancelAction(ctx, 'c1')).toMatchObject({ status: 'expired', message: 'Already expired.' });
    expect((await store.getAction('c1'))?.status).toBe('expired');
    expect(funnel('expired', 'message')).toBe(1);
    expect(await cancelAction(ctx, 'c1')).toMatchObject({ status: 'expired' });
    await store.purgeExpired(Date.now());
    expect(funnel('expired', 'message')).toBe(1);
    expect(funnel('cancelled', 'message')).toBe(0);
  });

  it('counts an expiry exactly once, whether a read or the purge finds it first', async () => {
    await store.createAction(action('e1', 'message', NOW - 1));
    await store.createAction(action('e2', 'message', NOW - 1));
    await store.createAction(action('e3', 'completion', NOW - 1));
    await store.createAction(action('live', 'message'));
    await store.updateAction('e1', { status: 'expired' }); // a confirm found it
    const res = await store.purgeExpired(NOW);
    expect(res.actionsExpired).toBe(2);
    await store.purgeExpired(NOW + 1000);
    await store.updateAction('e2', { status: 'expired' }); // already expired by the purge
    expect(funnel('expired', 'message')).toBe(2);
    expect(funnel('expired', 'completion')).toBe(1);
    expect((await store.getAction('live'))?.status).toBe('pending');
  });

  it('counts a pending row becoming superseded exactly once for its kind', async () => {
    await store.createAction(action('s1', 'forum_discussion'));
    await store.createAction(action('s2', 'forum_discussion'));
    await store.createAction(action('s3', 'message'));
    expect(await store.updateAction('s1', { status: 'superseded' })).toBe(true);
    expect(await store.updateAction('s1', { status: 'superseded' })).toBe(false);
    expect(await store.updateAction('s1', { status: 'cancelled' })).toBe(false);
    expect(funnel('superseded', 'forum_discussion')).toBe(1);
    expect(funnel('superseded', 'message')).toBe(0);
    expect(funnel('cancelled', 'forum_discussion')).toBe(0);
    expect((await store.getAction('s1'))?.status).toBe('superseded');
    expect((await store.getAction('s2'))?.status).toBe('pending');
  });
});

describe('getUsageStats (finer sections)', () => {
  const report = () => store.getUsageStats(7, NOW);

  it('reports failures and latency per tool, pages, hours and channels', async () => {
    await store.recordToolCall({
      userId: 1,
      createdAt: SIGNUP,
      client: 'Claude',
      tool: 'get_grades',
      ms: 4000,
      failure: 'moodle_unavailable',
      now: NOW,
    });
    await call(1, 'Claude', 'get_grades');
    await web(1, 'due');
    await web(2, 'due');
    await web(2, 'keys', NOW - DAY);
    const r = await report();
    expect(r.tools).toEqual([
      {
        name: 'get_grades',
        calls: 2,
        errors: 1,
        failures: {
          needs_reconnect: 0,
          moodle_unavailable: 1,
          mail_unavailable: 0,
          invalid_input: 0,
          forbidden: 0,
          budget: 0,
          other: 0,
        },
        latency: { lt1s: 1, '1to3s': 0, '3to10s': 1, gt10s: 0 },
      },
    ]);
    expect(r.pages).toEqual([
      { name: 'due', requests: 2 },
      { name: 'keys', requests: 1 },
    ]);
    expect(r.hours.mcp).toHaveLength(24);
    expect(r.hours.mcp[12]).toBe(2);
    expect(r.hours.web[12]).toBe(3);
    expect(r.hours.web.reduce((a, b) => a + b, 0)).toBe(3);
    expect(r.channels.today).toEqual({ mcp: 1, web: 2, total: 2 });
    expect(r.channels.week).toEqual({ mcp: 1, web: 2, total: 2 });
    expect(r.users).toMatchObject({ activeToday: 1, activeWeek: 1, activeMonth: 1 }); // MCP, as before
    expect(r.daily.at(-1)).toMatchObject({ active: 1, activeWeb: 2, activeAll: 2, webRequests: 2 });
    expect(r.daily.at(-2)).toMatchObject({ active: 0, activeWeb: 1, activeAll: 1, webRequests: 1 });
  });

  it('reports credential health: live snapshot, renewals, failure reasons and connect methods', async () => {
    const key = (id: number, status: 'active' | 'invalid', extra: string) =>
      t.sqlite
        .prepare(
          `INSERT INTO credentials (user_id, token_enc, private_token_enc, token_hash, token_hint, status,
             connected_via, connected_at, session_enc) VALUES (?, 'x', ?, 'h', 'tttt', ?, 'paste', 1, ?)`,
        )
        .run(id, extra === 'private' ? 'p' : null, status, extra === 'session' ? 's' : null);
    for (const id of [1, 2, 3, 4]) {
      t.sqlite
        .prepare(
          "INSERT INTO users (id, moodle_user_id, fullname, lang, settings, created_at) VALUES (?, ?, 'U', 'en', '{}', 1)",
        )
        .run(id, 2000 + id);
    }
    key(1, 'active', 'private');
    key(2, 'active', '');
    key(3, 'invalid', 'session');
    key(4, 'invalid', 'private'); // an invalid credential cannot open a session
    await store.recordCounts(NOW, [
      { metric: 'renew_renewed', dim: '' },
      { metric: 'renew_kept', dim: '' },
      { metric: 'renew_kept', dim: '' },
      { metric: 'renew_failed', dim: 'unavailable' },
      { metric: 'connect', dim: 'bookmarklet' },
    ]);
    await store.recordCounts(NOW - DAY, [
      { metric: 'connect', dim: 'paste' },
      { metric: 'connect', dim: 'paste' },
    ]);
    const r = await report();
    expect(r.credentials).toEqual({
      active: 2,
      invalid: 2,
      autoRenew: 2,
      renewed: 1,
      kept: 2,
      failed: 1,
      failures: [{ reason: 'unavailable', count: 1 }],
      connects: [
        { via: 'paste', count: 2 },
        { via: 'bookmarklet', count: 1 },
      ],
    });
    expect(r.daily.at(-1)).toMatchObject({ renewed: 1, renewKept: 2, renewFailed: 1, connects: 1 });
  });

  it('reports the write funnel per kind and calendar fetches per day', async () => {
    const insert = t.sqlite.prepare('INSERT INTO usage_counts (period, metric, dim, value) VALUES (?, ?, ?, ?)');
    insert.run(P.day, 'action_prepared', 'message', 5);
    insert.run(P.day, 'action_executed', 'message', 3);
    insert.run(P.day, 'action_expired', 'message', 1);
    insert.run(P.day, 'action_prepared', 'forum_reply', 6);
    insert.run(P.day, 'action_cancelled', 'forum_reply', 2);
    insert.run(P.day, 'action_superseded', 'forum_reply', 1);
    await store.recordFeedFetch({ ownerId: 1, now: NOW });
    await store.recordFeedFetch({ ownerId: 1, now: NOW });
    const r = await report();
    expect(r.actions).toEqual([
      {
        kind: 'forum_reply',
        prepared: 6,
        executed: 0,
        failed: 0,
        cancelled: 2,
        expired: 0,
        superseded: 1,
      },
      { kind: 'message', prepared: 5, executed: 3, failed: 0, cancelled: 0, expired: 1, superseded: 0 },
    ]);
    expect(r.daily.at(-1)).toMatchObject({ icsFetches: 2, icsFeeds: 1 });
  });

  it('reports retention only for merged signup groups of at least 3, within fixed blocks', async () => {
    // NOW is in the block starting Monday 2026-08-03 (12-week blocks from 1970-01-05); the previous one starts 05-11
    const insert = t.sqlite.prepare('INSERT INTO usage_counts (period, metric, dim, value) VALUES (?, ?, ?, ?)');
    const signups = (week: string, n: number) => insert.run(`w:${week}`, 'signups', '', n);
    const back = (week: string, offset: string, n: number) => insert.run(`w:${week}`, 'retained', offset, n);
    signups('2026-07-20', 2); // previous block's remainder: never merged across the boundary
    back('2026-07-20', '1', 1);
    signups('2026-08-03', 2);
    signups('2026-08-31', 1);
    back('2026-08-03', '1', 1);
    back('2026-08-03', '4', 1);
    back('2026-08-31', '2', 1);
    signups('2026-09-14', 5);
    back('2026-09-14', '1', 4);
    back('2026-09-14', '4', 2);
    signups('2026-09-28', 3);
    back('2026-09-28', '1', 1);
    signups('2026-10-05', 1); // with this week: a remainder of 2, not reported
    back('2026-10-05', '1', 1);
    signups(jstWeekStart(NOW), 1);
    const r = await report();
    expect(r.retention).toEqual([
      { from: '2026-08-03', to: '2026-08-31', users: 3, w1: 1, w2: 1, w4: 1 },
      { from: '2026-09-14', to: '2026-09-14', users: 5, w1: 4, w2: 0, w4: 2 },
      { from: '2026-09-28', to: '2026-09-28', users: 3, w1: 1, w2: 0, w4: null }, // 4 weeks later is not yet
    ]);
    // nothing about the suppressed weeks appears in the retention view
    const view = JSON.stringify(r.retention);
    for (const week of ['2026-07-20', '2026-10-05', jstWeekStart(NOW)]) expect(view).not.toContain(week);
  });

  it('counts signups at account creation and keeps them when an account is deleted', async () => {
    const week = usagePeriods(Date.now()).week;
    const ids: number[] = [];
    for (const m of [7001, 7002, 7003]) {
      ids.push((await store.upsertUser({ moodleUserId: m, fullname: 'Hanako Sato', lang: 'ja' })).id);
    }
    const again = await store.upsertUser({ moodleUserId: 7001, fullname: 'Taro Yamada', lang: 'en' });
    expect(again).toMatchObject({ id: ids[0], fullname: 'Taro Yamada', lang: 'en' }); // an update, not a signup
    expect(value(week, 'signups')).toBe(3);
    await store.deleteUser(ids[1] as number);
    expect(value(week, 'signups')).toBe(3);
    const r = await store.getUsageStats(7, Date.now());
    expect(r.retention.at(-1)).toMatchObject({ to: week.slice(2), users: 3, w1: null });
    expect(r.users.total).toBe(2); // the live total stays separate
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
