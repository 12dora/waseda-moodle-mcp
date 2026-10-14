import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import { NeedsReconnect } from '../../src/core/errors';
import { resolveScope } from '../../src/core/services/scope';
import { sweepForCron } from '../../src/core/services/sweep';
import { getRuntime } from '../../src/worker/context';
import type { Env } from '../../src/worker/env';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { runCourseSweep, SWEEP_CALL_BUDGET, SWEEP_MAX_USERS } from '../../src/worker/sweep-cron';
import { createTestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

vi.mock('../../src/core/services/sweep', () => ({ sweepForCron: vi.fn() }));
vi.mock('../../src/core/services/scope', () => ({ resolveScope: vi.fn() }));

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 3)));
const STATS = { checked: 0, stale: 0, checkedAt: null };

let env: Env;
let store: D1Store;
let moodleCalls: number;
const seen: ServiceContext[] = [];
/** moodleUserId -> how many Moodle calls the fake sweep makes (or an error to throw instead). */
let plan: Map<number, number | Error>;

async function addUser(moodleUserId: number, status: 'active' | 'invalid' = 'active', lastSeenAt?: number) {
  const user = await store.upsertUser({ moodleUserId, fullname: `User ${moodleUserId}`, lang: 'en' });
  if (lastSeenAt !== undefined) await store.touchUser(user.id, lastSeenAt);
  const rt = await getRuntime(env);
  await store.putCredential({
    userId: user.id,
    tokenEnc: await rt.key.encrypt('t'.repeat(32)),
    privateTokenEnc: null,
    tokenHash: `h${moodleUserId}`,
    tokenHint: 'tttt',
    status,
    connectedVia: 'paste',
    connectedAt: 1,
    lastOkAt: Date.now(), // fresh: no lastOkAt write races the assertions
    lastError: null,
  });
  return user;
}

beforeEach(() => {
  const { db } = createTestD1();
  env = {
    DB: db,
    OAUTH_KV: new MemoryKV().asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: 'https://wasemoodle.example.com',
  } as Env;
  store = createD1Store(db);
  moodleCalls = 0;
  seen.length = 0;
  plan = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      moodleCalls++;
      return Response.json({});
    }),
  );
  vi.mocked(resolveScope).mockReset().mockResolvedValue({ mode: 'auto', mine: new Set(), courses: [] });
  vi.mocked(sweepForCron)
    .mockReset()
    .mockImplementation(async (ctx) => {
      seen.push(ctx);
      const step = plan.get(ctx.user.moodleUserId) ?? 0;
      const api = await ctx.moodle();
      if (step instanceof Error) throw step;
      // distinct params: the client memoises identical reads
      for (let i = 0; i < step; i++) await api.call('core_webservice_get_site_info', { i });
      return STATS;
    });
});

afterEach(() => vi.unstubAllGlobals());

describe('runCourseSweep', () => {
  it('sweeps users with an active credential as a read-only system caller, least recently swept first', async () => {
    const stale = await addUser(1001);
    const fresh = await addUser(1002);
    await addUser(1003, 'invalid');
    await store.markSwept(fresh.id, 5);
    await store.markSwept(stale.id, 1);

    const summary = await runCourseSweep(env);

    expect(summary).toEqual({ swept: 2, skipped: 0, failed: 0, calls: 0 });
    expect(seen.map((c) => c.user.moodleUserId)).toEqual([1001, 1002]);
    expect(seen[0]).toMatchObject({ mode: 'worker', source: 'Scheduled sweep', scopes: ['moodle:read'] });
    expect(sweepForCron).toHaveBeenCalledWith(expect.anything(), { maxRefresh: 2 });
  });

  it('resolves the scope without syllabus fetches or the calendar call, before the sweep uses it', async () => {
    await addUser(1001);
    await runCourseSweep(env);
    expect(resolveScope).toHaveBeenCalledWith(seen[0], { syllabusLookup: false, calendarSignal: false });
    expect(vi.mocked(resolveScope).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sweepForCron).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('stamps last_swept_at for every attempted user, failures included, and rotates the queue', async () => {
    const a = await addUser(1001);
    const b = await addUser(1002);
    plan.set(1001, new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runCourseSweep(env);
    err.mockRestore();
    expect(seen.map((c) => c.user.id)).toEqual([a.id, b.id]);
    const row = (id: number) =>
      env.DB.prepare('SELECT last_swept_at AS t FROM users WHERE id = ?').bind(id).first<{ t: number }>();
    expect((await row(a.id))?.t).toBeGreaterThan(0);
    expect((await row(b.id))?.t).toBeGreaterThan(0);
    seen.length = 0;
    await store.markSwept(a.id, 1); // a is now the least recently swept
    await runCourseSweep(env);
    expect(seen.map((c) => c.user.id)).toEqual([a.id, b.id]);
  });

  it('visits at most 20 users per run', async () => {
    for (let i = 0; i < 23; i++) await addUser(2000 + i);
    const summary = await runCourseSweep(env);
    expect(summary.swept).toBe(SWEEP_MAX_USERS);
    expect(sweepForCron).toHaveBeenCalledTimes(20);
  });

  it('does not count the sweep as the user being active', async () => {
    const u = await addUser(1001, 'active', 1);
    await runCourseSweep(env);
    expect((await store.getUser(u.id))?.lastSeenAt).toBe(1);
  });

  it('skips users who need to reconnect and survives other failures', async () => {
    await addUser(1001);
    await addUser(1002);
    await addUser(1003);
    plan.set(1001, new NeedsReconnect());
    plan.set(1002, new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const summary = await runCourseSweep(env);

    expect(summary).toMatchObject({ swept: 1, skipped: 1, failed: 1 });
    expect(seen.map((c) => c.user.moodleUserId)).toEqual([1001, 1002, 1003]);
    expect(err).toHaveBeenCalledWith('sweep failed:', 'Error'); // name only, never the message
    err.mockRestore();
  });

  it('spends at most 44 Moodle calls in total and stops once the budget is gone', async () => {
    for (const id of [1001, 1002, 1003, 1004]) {
      await addUser(id);
      plan.set(id, 20);
    }
    const summary = await runCourseSweep(env);
    // user 1: 20, user 2: 20, user 3 gets the remaining 4 -> below the per-user minimum, so it never starts
    expect(summary).toEqual({ swept: 2, skipped: 0, failed: 0, calls: 40 });
    expect(moodleCalls).toBe(40);
    expect(seen).toHaveLength(2);
    expect(SWEEP_CALL_BUDGET).toBeLessThan(45);
  });

  it('hands each user only the calls that are left and aborts when a client runs dry', async () => {
    for (const id of [1001, 1002, 1003]) {
      await addUser(id);
      plan.set(id, 30);
    }
    const summary = await runCourseSweep(env);
    // user 1 spends 30; user 2 has 14 left and hits BudgetExceeded on its 15th call -> run ends, user 3 untouched
    expect(moodleCalls).toBe(SWEEP_CALL_BUDGET);
    expect(summary.calls).toBe(SWEEP_CALL_BUDGET);
    expect(summary.swept).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it('does nothing when no user has a usable credential', async () => {
    await addUser(1001, 'invalid');
    expect(await runCourseSweep(env)).toEqual({ swept: 0, skipped: 0, failed: 0, calls: 0 });
    expect(sweepForCron).not.toHaveBeenCalled();
  });
});
