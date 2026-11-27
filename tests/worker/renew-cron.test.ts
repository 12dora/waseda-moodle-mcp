import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvocationBudget } from '../../src/core/budget';
import type { UserRow } from '../../src/core/context';
import { sha256Hex } from '../../src/core/crypto';
import { getRuntime } from '../../src/worker/context';
import type { Env } from '../../src/worker/env';
import { meterD1 } from '../../src/worker/metered-d1';
import { RENEW_MAX_USERS, runRenewal } from '../../src/worker/renew-cron';
import { resetSiteFlagMemory } from '../../src/worker/site-flag';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { fakeMoodleSession, SESSKEY } from '../helpers/fake-moodle-session';
import { fakeMoodleWeb } from '../helpers/fake-moodle-web';
import { MemoryKV } from '../helpers/memory-kv';

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 31)));
const TOKEN = 'a'.repeat(32);
const HOUR = 3_600_000;

let env: Env;
let store: D1Store;
let app: ReturnType<typeof fakeMoodleWeb>;
let moodle: ReturnType<typeof fakeMoodleSession>;

interface Seed {
  sessionOkAt?: number;
  privateToken?: string;
  /** false: no sesskey stored yet. */
  sesskey?: boolean;
  session?: boolean;
}

const cookieOf = (moodleUserId: number) => `MoodleSession=u${moodleUserId}`;

/** A user with a stored session ("MoodleSession=u<id>", live unless the test ends it) and, optionally, a token. */
async function addUser(moodleUserId: number, opts: Seed = {}): Promise<UserRow> {
  const user = await store.upsertUser({ moodleUserId, fullname: `User ${moodleUserId}`, lang: 'en' });
  await store.touchUser(user.id, 1234);
  const { key } = await getRuntime(env);
  const token = opts.privateToken ? TOKEN : null;
  await store.putCredential({
    userId: user.id,
    tokenEnc: token ? await key.encrypt(token) : null,
    privateTokenEnc: opts.privateToken ? await key.encrypt(opts.privateToken) : null,
    tokenHash: token ? await sha256Hex(token) : null,
    tokenHint: token ? token.slice(-4) : null,
    status: 'active',
    connectedVia: 'extension',
    connectedAt: 1,
    lastOkAt: 1,
    lastError: null,
  });
  if (opts.session === false) return user;
  const cookie = cookieOf(moodleUserId);
  await store.updateCredentialStatus(user.id, {
    sessionEnc: await key.encrypt(cookie),
    sesskeyEnc: opts.sesskey === false ? null : await key.encrypt(SESSKEY),
    sessionOkAt: opts.sessionOkAt ?? 1,
  });
  moodle.state.live.add(cookie);
  app.state.live.add(cookie);
  return user;
}

beforeEach(() => {
  resetSiteFlagMemory();
  const { db } = createTestD1();
  env = {
    DB: db,
    OAUTH_KV: new MemoryKV().asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: 'https://wasemoodle.example.com',
  } as Env;
  store = createD1Store(db);
  app = fakeMoodleWeb({ token: TOKEN });
  moodle = fakeMoodleSession({}, app.fetch);
  vi.stubGlobal('fetch', vi.fn(moodle.fetch));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 27, 3, 17));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** One scheduled invocation's keepalive: its own budget, with D1 metered like runScheduled does. */
async function tick(opts: { moodle?: number; queries?: number; reserve?: { moodle: number; queries: number } } = {}) {
  const budget = new InvocationBudget(opts.moodle ?? 44, opts.queries ?? 45);
  const summary = await runRenewal({ ...env, DB: meterD1(env.DB, budget) }, budget, opts.reserve);
  return { ...summary, budget };
}

const credentialOf = async (user: UserRow) => {
  const c = await store.getCredential(user.id);
  if (!c) throw new Error('credential missing');
  return c;
};

/** Every session was confirmed less than `maxIdleMs` ago (Moodle ends a session after 4 h idle). */
async function expectAlive(users: UserRow[], maxIdleMs: number): Promise<void> {
  for (const u of users) {
    const okAt = (await credentialOf(u)).sessionOkAt ?? 0;
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

const paths = () => moodle.requests.map((r) => r.path);

describe('site flag', () => {
  it('asks Moodle once per run, stores a change and keeps the value while Moodle cannot say', async () => {
    moodle.state.mobileService = true;
    await tick();
    expect(paths()).toEqual(['/lib/ajax/service-nologin.php']);
    expect(await store.getSiteState('mobile_service')).toBe('1');

    moodle.state.down = true;
    await tick();
    expect(await store.getSiteState('mobile_service')).toBe('1');

    moodle.state.down = false;
    moodle.state.mobileService = false;
    await tick();
    expect(await store.getSiteState('mobile_service')).toBe('0');
  });
});

describe('runRenewal', () => {
  it('touches each stored session with one request and skips the recently used ones', async () => {
    const now = Date.now();
    const idle = await addUser(1001, { sessionOkAt: now - 2 * HOUR });
    const recent = await addUser(1002, { sessionOkAt: now - 10 * 60_000 });
    await addUser(1003, { session: false, privateToken: 'Priv4teTok3n' }); // nothing to keep alive
    expect(await tick()).toMatchObject({ kept: 1, failed: 0, calls: 1 });
    expect(paths()).toEqual(['/lib/ajax/service-nologin.php', '/lib/ajax/service.php']);
    expect((await credentialOf(idle)).sessionOkAt).toBe(now);
    expect((await credentialOf(recent)).sessionOkAt).toBe(now - 10 * 60_000);
  });

  it('skips a session marked busy (a request ran out of time) without a request, and visits it once the mark ran out', async () => {
    const now = Date.now();
    const busy = await addUser(1001, { sessionOkAt: now - 2 * HOUR });
    await store.updateCredentialStatus(busy.id, { busyUntil: now + 60_000 });
    expect(await tick()).toMatchObject({ kept: 0, skipped: 1, calls: 0, reasons: { busy: 1 } });
    expect(paths()).toEqual(['/lib/ajax/service-nologin.php']);
    expect(await counters()).toEqual([]); // a skip is no credential-health event
    expect((await credentialOf(busy)).sessionOkAt).toBe(now - 2 * HOUR);

    vi.setSystemTime(now + 61_000);
    expect(await tick()).toMatchObject({ kept: 1, skipped: 0, calls: 1 });
  });

  it('reads a missing sesskey once', async () => {
    const user = await addUser(1001, { sesskey: false });
    expect(await tick()).toMatchObject({ kept: 1, calls: 2 });
    expect((await credentialOf(user)).sesskeyEnc).not.toBeNull();
    vi.setSystemTime(Date.now() + HOUR);
    expect(await tick()).toMatchObject({ kept: 1, calls: 1 });
  });

  it('forgets an ended session, asks for a reconnect and counts it', async () => {
    const user = await addUser(1001);
    moodle.state.live.clear();
    expect(await tick()).toMatchObject({ ended: 1, failed: 0 });
    expect(await credentialOf(user)).toMatchObject({
      sessionEnc: null,
      status: 'invalid',
      lastError: 'The Moodle session ended. Reconnect to continue.',
    });
    expect(await counters()).toEqual([{ metric: 'renew_ended', dim: '', value: 1 }]);
    vi.setSystemTime(Date.now() + HOUR);
    expect(await tick()).toMatchObject({ ended: 0, calls: 0 });
  });

  it('while the service is on, every session goes through launch.php: renewed tokens, and session-only users get one', async () => {
    moodle.state.mobileService = true;
    app.state.token = 'c'.repeat(32);
    const withToken = await addUser(1001, { privateToken: 'Priv4teTok3n' });
    const sessionOnly = await addUser(1002);
    expect(await tick()).toMatchObject({ renewed: 2, calls: 2 });
    expect(app.requests.map((r) => r.path)).toEqual(['/admin/tool/mobile/launch.php', '/admin/tool/mobile/launch.php']);
    expect((await credentialOf(withToken)).tokenHint).toBe('cccc');
    expect((await credentialOf(sessionOnly)).tokenHint).toBe('cccc');
    expect(await counters()).toEqual([{ metric: 'renew_renewed', dim: '', value: 2 }]);
  });

  it('only touches a session with a private token while the service is off', async () => {
    await addUser(1001, { privateToken: 'Priv4teTok3n' });
    expect(await tick()).toMatchObject({ kept: 1, calls: 1 });
    expect(app.requests).toEqual([]);
  });

  it('is background work: no activity stamp, only credential-health counters, no connect entries', async () => {
    const user = await addUser(1001);
    await tick();
    expect((await store.getUser(user.id))?.lastSeenAt).toBe(1234);
    expect(await counters()).toEqual([{ metric: 'renew_kept', dim: '', value: 1 }]);
    const seen = await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_seen').first<{ n: number }>();
    expect(seen?.n).toBe(0);
    expect(await store.listAudit(user.id, { limit: 10 })).toEqual([]);
  });

  it('spends one D1 write per healthy session', async () => {
    for (let i = 0; i < 10; i++) await addUser(2000 + i);
    const run = await tick();
    expect(run).toMatchObject({ kept: 10, calls: 10 });
    expect(44 - run.budget.moodle).toBe(1 + 10); // the site check and one request per session
    // the flag read, the listing, one write per session, ONE summed counter upsert
    expect(45 - run.budget.queries).toBe(1 + 1 + 10 + 1);
  });

  it('stops before the budget minus the reserve runs out', async () => {
    for (let i = 0; i < 10; i++) await addUser(2000 + i);
    const tight = await tick({ reserve: { moodle: 40, queries: 0 } });
    expect(tight.calls).toBe(3);
    expect(tight.budget.moodle).toBe(40);

    vi.setSystemTime(Date.now() + HOUR);
    const queries = await tick({ reserve: { moodle: 0, queries: 35 } });
    expect(queries.kept).toBeGreaterThan(0);
    expect(queries.kept).toBeLessThan(10);
    expect(queries.budget.queries).toBeGreaterThanOrEqual(35);
    expect(queries.failed).toBe(0);
  });

  it('caps the users per run and visits the most idle first', async () => {
    const users: UserRow[] = [];
    for (let i = 0; i <= RENEW_MAX_USERS; i++) users.push(await addUser(2000 + i, { sessionOkAt: 1000 + i }));
    const run = await tick({ moodle: 1000, queries: 1000 });
    expect(run).toMatchObject({ kept: RENEW_MAX_USERS, calls: RENEW_MAX_USERS });
    const last = users.at(-1) as UserRow;
    expect((await credentialOf(last)).sessionOkAt).toBe(1000 + RENEW_MAX_USERS);
  });

  it('rotates failing sessions behind the others and keeps their confirmation time', async () => {
    const start = Date.now();
    moodle.state.broken = new Set();
    const failing: UserRow[] = [];
    for (let i = 0; i < RENEW_MAX_USERS; i++) {
      moodle.state.broken.add(cookieOf(4000 + i));
      failing.push(await addUser(4000 + i, { sessionOkAt: start - 2 * HOUR }));
    }
    const healthy = await addUser(4999, { sessionOkAt: start - HOUR });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const big = { moodle: 1000, queries: 1000 };

    expect(await tick(big)).toMatchObject({ failed: RENEW_MAX_USERS, reasons: { unavailable: RENEW_MAX_USERS } });
    expect(spy).toHaveBeenCalledWith('keepalive failed:', JSON.stringify({ unavailable: RENEW_MAX_USERS }));
    expect((await credentialOf(healthy)).sessionOkAt).toBe(start - HOUR); // not reached yet

    vi.setSystemTime(start + HOUR);
    expect((await tick(big)).kept).toBe(1); // the healthy session went first: the others were tried an hour ago
    expect((await credentialOf(healthy)).sessionOkAt).toBe(start + HOUR);
    for (const u of failing) {
      const c = await credentialOf(u);
      expect(c.sessionOkAt).toBe(start - 2 * HOUR); // liveness untouched by failures
      expect(c.sessionTriedAt).toBeGreaterThanOrEqual(start);
      expect(c.sessionEnc).not.toBeNull();
    }
  });

  // the real schedule (index.ts): every hour; the day runs leave the sweep its share, 15–21 UTC do the keepalive only
  const SWEEP_RESERVE = { moodle: 14, queries: 20 };

  it.each([22, RENEW_MAX_USERS])('keeps %i sessions alive over a whole day of real runs', async (n) => {
    const tickAt = (h: number) => Date.UTC(2026, 10, 27, h, 17);
    const users: UserRow[] = [];
    for (let i = 0; i < n; i++) users.push(await addUser(5000 + i, { sessionOkAt: tickAt(0) - HOUR }));
    for (let h = 0; h < 24; h++) {
      vi.setSystemTime(tickAt(h));
      await expectAlive(users, 4 * HOUR - 5 * 60_000); // with margin before Moodle's idle limit
      const night = h >= 15 && h <= 21;
      const run = await tick({ reserve: night ? undefined : SWEEP_RESERVE });
      expect(run.failed).toBe(0);
      if (night) continue;
      expect(run.budget.moodle).toBeGreaterThanOrEqual(SWEEP_RESERVE.moodle);
      expect(run.budget.queries).toBeGreaterThanOrEqual(SWEEP_RESERVE.queries);
    }
    vi.setSystemTime(tickAt(24));
    await expectAlive(users, 4 * HOUR - 5 * 60_000);
  });
});
