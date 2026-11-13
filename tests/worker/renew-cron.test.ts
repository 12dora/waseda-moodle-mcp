import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvocationBudget } from '../../src/core/budget';
import type { UserRow } from '../../src/core/context';
import { sha256Hex } from '../../src/core/crypto';
import { AUTOLOGIN_RETRY_MS } from '../../src/core/services/credential-renewal';
import { getRuntime } from '../../src/worker/context';
import type { Env } from '../../src/worker/env';
import { meterD1 } from '../../src/worker/metered-d1';
import { RENEW_MAX_USERS, runRenewal } from '../../src/worker/renew-cron';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { fakeMoodleWeb } from '../helpers/fake-moodle-web';
import { MemoryKV } from '../helpers/memory-kv';

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 31)));
const TOKEN = 'a'.repeat(32);
const HOUR = 3_600_000;

let env: Env;
let store: D1Store;
let web: ReturnType<typeof fakeMoodleWeb>;

async function addUser(
  moodleUserId: number,
  opts: { session?: string; sessionOkAt?: number; privateToken?: string; autologinAt?: number } = {},
): Promise<UserRow> {
  const user = await store.upsertUser({ moodleUserId, fullname: `User ${moodleUserId}`, lang: 'en' });
  await store.touchUser(user.id, 1234);
  const { key } = await getRuntime(env);
  await store.putCredential({
    userId: user.id,
    tokenEnc: await key.encrypt(TOKEN),
    privateTokenEnc: opts.privateToken ? await key.encrypt(opts.privateToken) : null,
    tokenHash: await sha256Hex(TOKEN),
    tokenHint: TOKEN.slice(-4),
    status: 'active',
    connectedVia: 'bookmarklet',
    connectedAt: 1,
    lastOkAt: 1,
    lastError: null,
  });
  await store.updateCredentialStatus(user.id, {
    sessionEnc: opts.session ? await key.encrypt(opts.session) : undefined,
    sessionOkAt: opts.sessionOkAt,
    autologinAt: opts.autologinAt,
  });
  if (opts.session) web.state.live.add(opts.session);
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
  web = fakeMoodleWeb({ token: TOKEN });
  vi.stubGlobal('fetch', vi.fn(web.fetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** One scheduled invocation's keepalive: its own budget, with D1 metered like runScheduled does. */
async function tick(opts: { moodle?: number; queries?: number; reserve?: { moodle: number; queries: number } } = {}) {
  const budget = new InvocationBudget(opts.moodle ?? 44, opts.queries ?? 45);
  const summary = await runRenewal({ ...env, DB: meterD1(env.DB, budget) }, budget, opts.reserve);
  return { ...summary, budget };
}

/** Every session was confirmed less than `maxIdleMs` ago (Moodle ends a session after 4 h idle). */
async function expectAlive(sessions: UserRow[], maxIdleMs: number): Promise<void> {
  for (const u of sessions) {
    const okAt = (await store.getCredential(u.id))?.sessionOkAt ?? 0;
    expect(Date.now() - okAt).toBeLessThan(maxIdleMs);
  }
}

/** Usage counters summed over their periods (signup sizes come from the test's own account setup). */
const counters = async () =>
  (
    await env.DB.prepare(
      `SELECT metric, dim, SUM(value) AS value FROM usage_counts WHERE metric != 'signups'
       GROUP BY metric, dim ORDER BY metric, dim`,
    ).all()
  ).results;

describe('runRenewal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 13, 3, 17));
  });

  it('visits live sessions with one call each and opens missing ones', async () => {
    const now = Date.now();
    const a = await addUser(1001, { session: 'MoodleSession=s1001', sessionOkAt: now - 2 * HOUR });
    const b = await addUser(1002, { privateToken: 'Priv4teTok3n' });
    const recent = await addUser(1003, { session: 'MoodleSession=s1003', sessionOkAt: now - 10 * 60_000 });
    const summary = await tick();
    expect(summary).toMatchObject({ kept: 2, failed: 0, calls: 4 });
    expect(summary.budget.moodle).toBe(40);
    expect((await store.getCredential(a.id))?.sessionOkAt).toBe(now);
    expect((await store.getCredential(b.id))?.sessionEnc).not.toBeNull();
    expect((await store.getCredential(recent.id))?.sessionOkAt).toBe(now - 10 * 60_000);
  });

  it('spends one D1 write per healthy session, and stops before the budget minus the reserve runs out', async () => {
    for (let i = 0; i < 10; i++) await addUser(2000 + i, { session: `MoodleSession=s${i}`, sessionOkAt: 1 });
    const all = await tick();
    expect(all).toMatchObject({ kept: 10, calls: 10 });
    expect(45 - all.budget.queries).toBe(1 + 10 + 1); // listing, one write per session, ONE summed counter upsert

    vi.setSystemTime(Date.now() + HOUR);
    const tight = await tick({ moodle: 44, queries: 45, reserve: { moodle: 40, queries: 30 } });
    expect(tight.calls).toBe(4); // 44 - 40 Moodle requests left for the keepalive
    expect(tight.budget.moodle).toBe(40);
    expect(tight.budget.queries).toBeGreaterThanOrEqual(30);
  });

  it('never starts an autologin it cannot finish', async () => {
    const first = await addUser(1001, { session: 'MoodleSession=s1001', sessionOkAt: 1 });
    const opener = await addUser(1002, { privateToken: 'Priv4teTok3n', autologinAt: 2 });
    const summary = await tick({ moodle: 3 });
    // the session is more urgent; the opener then needs three requests and only two are left
    expect(summary).toMatchObject({ kept: 1, skipped: 1, calls: 1, reasons: { budget: 1 } });
    expect((await store.getCredential(first.id))?.sessionOkAt).toBe(Date.now());
    expect((await store.getCredential(opener.id))?.autologinAt).toBe(2);
  });

  it('counts each run in the credential-health counters: kept, renewed and failures by reason', async () => {
    await addUser(1001, { session: 'MoodleSession=s1001', sessionOkAt: 1 });
    await addUser(1002, { session: 'MoodleSession=s1002', sessionOkAt: 1 });
    await tick();
    expect(await counters()).toEqual([{ metric: 'renew_kept', dim: '', value: 2 }]);

    web.state.keyError = 'autologinkeygenerationlockout';
    await addUser(1003, { privateToken: 'Priv4teTok3n' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.setSystemTime(Date.now() + 10 * 60_000); // the live sessions were just confirmed: only the opener runs
    await tick();
    spy.mockRestore();
    expect(await counters()).toEqual([
      { metric: 'renew_failed', dim: 'autologinkeygenerationlockout', value: 1 },
      { metric: 'renew_kept', dim: '', value: 2 },
    ]);
  });

  it('caps the users per run', async () => {
    for (let i = 0; i <= RENEW_MAX_USERS; i++) {
      await addUser(2000 + i, { session: `MoodleSession=s${i}`, sessionOkAt: 1 });
    }
    const summary = await tick({ moodle: 1000, queries: 1000 });
    expect(summary.kept).toBe(RENEW_MAX_USERS);
    expect(summary.calls).toBe(RENEW_MAX_USERS);
  });

  it('is fair across runs: a waiting setup gets its turn, no session idles out', async () => {
    const start = Date.now();
    const sessions: UserRow[] = [];
    for (let i = 0; i < RENEW_MAX_USERS; i++) {
      sessions.push(await addUser(3000 + i, { session: `MoodleSession=f${i}`, sessionOkAt: start - HOUR }));
    }
    const waiting = await addUser(3999, { privateToken: 'Priv4teTok3n', autologinAt: start - AUTOLOGIN_RETRY_MS - 1 });

    const first = await tick(); // the D1 budget, not the user cap, limits this run
    expect(first).toMatchObject({ failed: 0, skipped: 0 });
    expect(first.calls).toBeGreaterThan(3);
    expect(first.budget.queries).toBeGreaterThanOrEqual(0);
    // the waiting setup went first (its retry came due before any session idles out)
    expect(web.requests[0]?.path).toBe('/webservice/rest/server.php');
    expect((await store.getCredential(waiting.id))?.sessionEnc).not.toBeNull();

    for (let hour = 1; hour <= 6; hour++) {
      vi.setSystemTime(start + hour * HOUR);
      const run = await tick();
      expect(run.failed).toBe(0);
      await expectAlive(sessions, 4 * HOUR); // never idle long enough for Moodle to end it
    }
  });

  // the real schedule (index.ts): hourly 00–14 and 22–23 UTC with the sweep's reserve, keepalive-only at 16 and 19
  const SWEEP_RESERVE = { moodle: 14, queries: 20 };
  const SCHEDULE_UTC = [...Array.from({ length: 15 }, (_, h) => h), 16, 19, 22, 23];

  /** The tick at UTC hour `h`: a night run visits all `n` sessions, a daytime run leaves the sweep its share. */
  async function scheduledTick(h: number, n: number): Promise<void> {
    const night = h === 16 || h === 19;
    const run = await tick({ reserve: night ? undefined : SWEEP_RESERVE });
    expect(run.failed).toBe(0);
    if (night) {
      expect(run.kept).toBe(n);
    } else if (h >= 1 && h <= 14) {
      expect(run.budget.queries).toBeGreaterThanOrEqual(SWEEP_RESERVE.queries);
      expect(run.budget.moodle).toBeGreaterThanOrEqual(SWEEP_RESERVE.moodle);
    }
  }

  it.each([22, 30])('keeps %i live sessions alive over a whole day of real ticks, with metered D1', async (n) => {
    const tickAt = (h: number) => Date.UTC(2026, 10, 13, h, 17);
    const sessions: UserRow[] = [];
    for (let i = 0; i < n; i++) {
      sessions.push(await addUser(5000 + i, { session: `MoodleSession=d${i}`, sessionOkAt: tickAt(0) - HOUR }));
    }
    for (const h of SCHEDULE_UTC) {
      vi.setSystemTime(tickAt(h));
      await expectAlive(sessions, 4 * HOUR - 5 * 60_000); // with margin before Moodle's idle limit
      await scheduledTick(h, n);
    }
    vi.setSystemTime(tickAt(24));
    await expectAlive(sessions, 4 * HOUR - 5 * 60_000);
  });

  it('a waiting setup only gets the capacity the sessions due before the next real tick leave', async () => {
    const tickAt = (h: number) => Date.UTC(2026, 10, 13, h, 17);
    vi.setSystemTime(tickAt(16));
    const sessions: UserRow[] = [];
    for (let i = 0; i < RENEW_MAX_USERS; i++) {
      // the last one has no private token: if it idled out, only a manual reconnect would bring it back
      const privateToken = i < RENEW_MAX_USERS - 1 ? 'Priv4teTok3n' : undefined;
      sessions.push(await addUser(6000 + i, { session: `MoodleSession=n${i}`, sessionOkAt: tickAt(14), privateToken }));
    }
    const waiting = await addUser(6999, { privateToken: 'Priv4teTok3n', autologinAt: tickAt(16) - 7 * HOUR });
    const lastSession = sessions[sessions.length - 1] as UserRow;

    await scheduledTick(16, RENEW_MAX_USERS); // all 30 would idle out before 19:17: the setup waits
    expect((await store.getCredential(lastSession.id))?.sessionOkAt).toBe(tickAt(16));
    expect((await store.getCredential(waiting.id))?.autologinAt).toBe(tickAt(16) - 7 * HOUR);

    for (const h of [19, 22, 23, ...Array.from({ length: 15 }, (_, i) => 24 + i)]) {
      vi.setSystemTime(tickAt(h));
      await expectAlive(sessions, 4 * HOUR - 5 * 60_000);
      await scheduledTick(h % 24, RENEW_MAX_USERS);
    }
    // the setup ran once the sessions left capacity (23:17, an hour before the next tick)
    expect((await store.getCredential(waiting.id))?.sessionEnc).not.toBeNull();
    vi.setSystemTime(tickAt(24 + 16));
    await expectAlive(sessions, 4 * HOUR - 5 * 60_000);
  });

  it('rotates failing sessions behind the others and keeps their confirmation time', async () => {
    const start = Date.now();
    web.state.odd = new Set();
    const failing: UserRow[] = [];
    for (let i = 0; i < RENEW_MAX_USERS; i++) {
      const cookie = `MoodleSession=x${i}`;
      web.state.odd.add(cookie);
      failing.push(await addUser(4000 + i, { session: cookie, sessionOkAt: start - 2 * HOUR }));
    }
    const healthy = await addUser(4999, { session: 'MoodleSession=ok01', sessionOkAt: start - HOUR });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const big = { moodle: 1000, queries: 1000 };

    expect(await tick(big)).toMatchObject({ failed: RENEW_MAX_USERS, reasons: { unavailable: RENEW_MAX_USERS } });
    expect((await store.getCredential(healthy.id))?.sessionOkAt).toBe(start - HOUR); // not reached yet

    vi.setSystemTime(start + HOUR);
    const second = await tick(big);
    expect(second.kept).toBe(1); // the healthy session went first: the failing ones were visited an hour ago
    expect((await store.getCredential(healthy.id))?.sessionOkAt).toBe(start + HOUR);
    for (const u of failing) {
      const c = await store.getCredential(u.id);
      expect(c?.sessionOkAt).toBe(start - 2 * HOUR); // liveness untouched by failures
      expect(c?.sessionTriedAt).toBeGreaterThanOrEqual(start);
      expect(c?.sessionEnc).not.toBeNull();
    }
    spy.mockRestore();
  });

  it('records refusals, does not throw and waits before the next autologin', async () => {
    web.state.keyError = 'autologinkeygenerationlockout';
    const user = await addUser(1001, { privateToken: 'Priv4teTok3n' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const now = Date.now();
    const first = await tick();
    expect(first).toMatchObject({ failed: 1, calls: 1, reasons: { autologinkeygenerationlockout: 1 } });
    expect(spy).toHaveBeenCalledWith('renewal failed:', JSON.stringify({ autologinkeygenerationlockout: 1 }));
    vi.setSystemTime(now + HOUR);
    expect(await tick()).toMatchObject({ failed: 0, calls: 0 });
    vi.setSystemTime(now + AUTOLOGIN_RETRY_MS + 60_000);
    expect(await tick()).toMatchObject({ failed: 1, calls: 1 });
    expect((await store.getCredential(user.id))?.status).toBe('active');
    spy.mockRestore();
  });

  it('is background work: no activity stamp, only credential-health counters, no connect entries', async () => {
    web.state.token = 'c'.repeat(32); // the token was renewed
    const user = await addUser(1001, { session: 'MoodleSession=s1001', sessionOkAt: 1 });
    expect(await tick()).toMatchObject({ renewed: 1 });
    expect((await store.getUser(user.id))?.lastSeenAt).toBe(1234);
    expect(await counters()).toEqual([{ metric: 'renew_renewed', dim: '', value: 1 }]);
    const seen = await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_seen').first<{ n: number }>();
    expect(seen?.n).toBe(0);
    const actions = (await store.listAudit(user.id, { limit: 10 })).map((r) => r.action);
    expect(actions).toEqual(['renew']);
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(users?.n).toBe(1);
  });
});
