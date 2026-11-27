import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/core/crypto';
import { MailNeedsReconnect, NeedsReconnect, NotFound } from '../../src/core/errors';
import type { ChannelClientOptions } from '../../src/core/moodle/web/channel';
import {
  buildServiceContext,
  consoleProps,
  getRuntime,
  LAST_OK_INTERVAL_MS,
  makeMoodleFactory,
  startRenewal,
} from '../../src/worker/context';
import type { Env } from '../../src/worker/env';
import { resetSiteFlagMemory } from '../../src/worker/site-flag';
import { resetUsageMemory } from '../../src/worker/store/usage';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { fakeMoodleWeb } from '../helpers/fake-moodle-web';
import { MemoryKV } from '../helpers/memory-kv';

const created = vi.hoisted(() => [] as unknown[]);

vi.mock('../../src/core/moodle/web/channel', () => ({
  createChannelClient: (opts: unknown) => {
    created.push(opts);
    return { opts };
  },
}));

/** The options the nth client of this test was created with. */
function options(n = 0): ChannelClientOptions {
  const opts = created[n];
  if (!opts) throw new Error('no Moodle client was created');
  return opts as ChannelClientOptions;
}

const tokenOf = (n = 0) => {
  const { token } = options(n);
  if (!token) throw new Error('the client has no token channel');
  return token;
};

const sessionOf = (n = 0) => {
  const { session } = options(n);
  if (!session) throw new Error('the client has no web channel');
  return session;
};

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 11)));

let env: Env;
let store: D1Store;
let userId: number;
let deferred: Promise<unknown>[];
const execCtx = () => ({ waitUntil: (p: Promise<unknown>) => void deferred.push(p) }) as unknown as ExecutionContext;

const serviceOn = () => store.putSiteState('mobile_service', '1', Date.now());

async function storeCredential(over: { status?: 'active' | 'invalid'; lastOkAt?: number | null } = {}) {
  const rt = await getRuntime(env);
  await store.putCredential({
    userId,
    tokenEnc: await rt.key.encrypt('t'.repeat(32)),
    privateTokenEnc: null,
    tokenHash: await sha256Hex('t'.repeat(32)),
    tokenHint: 'tttt',
    status: over.status ?? 'active',
    connectedVia: 'paste',
    connectedAt: 1,
    lastOkAt: over.lastOkAt ?? null,
    lastError: null,
  });
}

beforeEach(async () => {
  resetSiteFlagMemory();
  created.length = 0;
  deferred = [];
  const { db } = createTestD1();
  env = {
    DB: db,
    OAUTH_KV: new MemoryKV().asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: 'https://wasemoodle.example.com/',
  } as Env;
  store = createD1Store(db);
  userId = (await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' })).id;
});

describe('getRuntime', () => {
  it('is built once per env and does not cache a bad key', async () => {
    expect(getRuntime(env)).toBe(getRuntime(env));
    const bad = { ...env, MASTER_KEY: 'short' } as Env;
    const first = getRuntime(bad);
    await expect(first).rejects.toThrow();
    await Promise.resolve();
    const second = getRuntime(bad);
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();
  });
});

describe('buildServiceContext', () => {
  it('fills the context from props and env', async () => {
    const ctx = await buildServiceContext(env, execCtx(), { userId, scopes: ['moodle:read'], source: 'Claude' });
    expect(ctx).toMatchObject({
      mode: 'worker',
      publicUrl: 'https://wasemoodle.example.com',
      scopes: ['moodle:read'],
      source: 'Claude',
      user: { id: userId, fullname: 'Taro Yamada' },
    });
    expect(typeof ctx.signer.sign).toBe('function');
    const ticket = await ctx.signer.sign({ k: 'dl' }, 60);
    expect(await ctx.signer.verify(ticket)).toMatchObject({ k: 'dl' });
  });

  it('throws NotFound for a deleted account', async () => {
    await expect(buildServiceContext(env, execCtx(), { userId: 999, scopes: [], source: 'x' })).rejects.toBeInstanceOf(
      NotFound,
    );
  });

  it('counts tool calls only when asked to (MCP requests), labelled by client', async () => {
    resetUsageMemory();
    const props = { userId, scopes: ['moodle:read' as const], source: 'API key: laptop' };
    const plain = await buildServiceContext(env, execCtx(), props);
    expect(plain.usage).toBeUndefined();

    const ctx = await buildServiceContext(env, execCtx(), props, { recordUsage: true });
    ctx.usage?.toolCall({ tool: 'list_courses', ms: 1500, failure: 'moodle_unavailable' });
    await Promise.all(deferred);
    const rows = await env.DB.prepare("SELECT metric, dim, value FROM usage_counts WHERE metric != 'active'").all();
    expect(rows.results).toEqual(
      expect.arrayContaining([
        { metric: 'calls', dim: 'list_courses', value: 1 },
        { metric: 'errors', dim: 'list_courses', value: 1 },
        { metric: 'failure', dim: 'list_courses|moodle_unavailable', value: 1 },
        { metric: 'latency', dim: 'list_courses|1to3s', value: 1 },
        { metric: 'client_calls', dim: 'API key', value: 1 },
        { metric: 'active_all', dim: '', value: 1 },
      ]),
    );
  });

  it('records last-seen at most once an hour', async () => {
    const user = await store.getUser(userId);
    expect(user?.lastSeenAt).not.toBeNull();
    await buildServiceContext(env, execCtx(), consoleProps(user!));
    expect(deferred).toHaveLength(0); // just created: fresh

    await store.touchUser(userId, Date.now() - 2 * 3_600_000);
    await buildServiceContext(env, execCtx(), consoleProps(user!));
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(Date.now() - ((await store.getUser(userId))?.lastSeenAt ?? 0)).toBeLessThan(5000);
  });

  it('background contexts can skip the last-seen update', async () => {
    const user = (await store.getUser(userId))!;
    await store.touchUser(userId, 1);
    await buildServiceContext(env, execCtx(), consoleProps(user), {
      user: { ...user, lastSeenAt: 1 },
      touchUser: false,
    });
    expect(deferred).toHaveLength(0);
    expect((await store.getUser(userId))?.lastSeenAt).toBe(1);
  });

  it('console props carry full scopes and the Console source', async () => {
    const user = (await store.getUser(userId))!;
    expect(consoleProps(user)).toEqual({ userId, scopes: ['moodle:read', 'moodle:write'], source: 'Console' });
  });
});

describe('ctx.moodle()', () => {
  const build = () => buildServiceContext(env, execCtx(), { userId, scopes: ['moodle:read'], source: 'Claude' });
  const LIVE = 'MoodleSession=ctx01';
  const counters = async () =>
    (
      await env.DB.prepare(
        "SELECT metric, dim, value FROM usage_counts WHERE metric != 'signups' ORDER BY metric, dim",
      ).all()
    ).results;

  /** Adds the web session to the stored credential. */
  async function addSession(sesskey?: string) {
    const rt = await getRuntime(env);
    await store.updateCredentialStatus(userId, {
      sessionEnc: await rt.key.encrypt(LIVE),
      sesskeyEnc: sesskey ? await rt.key.encrypt(sesskey) : null,
      sessionOkAt: 1,
    });
  }

  /** A credential without any app token. */
  async function sessionOnly(status: 'active' | 'invalid' = 'active') {
    await storeCredential({ status });
    await store.updateCredentialStatus(userId, { tokenEnc: null, tokenHash: null, tokenHint: null });
    await addSession('Sk00000001');
  }

  const plain = async (enc: string | null | undefined) => (enc ? (await getRuntime(env)).key.decrypt(enc) : null);

  describe('channel choice', () => {
    it('needs a stored credential with a usable channel', async () => {
      await expect((await build()).moodle()).rejects.toThrow(/browser extension or Moodle session cookie/);
      await serviceOn();
      await storeCredential({ status: 'invalid' });
      await expect((await build()).moodle()).rejects.toBeInstanceOf(NeedsReconnect);
      expect(created).toHaveLength(0);
    });

    it('cannot use a token alone while the mobile web service is off', async () => {
      await storeCredential();
      await expect((await build()).moodle()).rejects.toThrow(/connection has ended/);
      expect(created).toHaveLength(0);
      expect(await store.getCredential(userId)).toMatchObject({ status: 'active' }); // nothing is thrown away
    });

    it('gives a token-only credential the token channel and shares one client per request', async () => {
      await serviceOn();
      await storeCredential();
      const ctx = await build();
      expect(await ctx.moodle()).toBe(await ctx.moodle());
      expect(created).toHaveLength(1);
      expect(options()).toMatchObject({ moodleUserId: 1001, mobileService: true, session: null });
      expect(tokenOf()).toMatchObject({ token: 't'.repeat(32), moodleUserId: 1001 });
      expect(tokenOf().renewToken).toBeUndefined();
    });

    it('gives a session-only credential the web channel with the decrypted cookie and sesskey', async () => {
      await sessionOnly();
      await (await build()).moodle();
      expect(options()).toMatchObject({ mobileService: false, token: null });
      expect(sessionOf()).toMatchObject({ moodleUserId: 1001, session: { cookie: LIVE, sesskey: 'Sk00000001' } });
    });

    it('offers both channels and says whether the mobile web service is on', async () => {
      await storeCredential();
      await addSession();
      await (await build()).moodle();
      expect(options().mobileService).toBe(false);
      expect(tokenOf().token).toBe('t'.repeat(32));
      expect(sessionOf().session).toMatchObject({ cookie: LIVE, sesskey: null });

      resetSiteFlagMemory();
      await serviceOn();
      await (await build()).moodle();
      expect(options(1).mobileService).toBe(true);
    });

    it('reads the site flag once per isolate for a few minutes', async () => {
      await sessionOnly();
      const rt = await getRuntime(env);
      const read = vi.spyOn(rt.store, 'getSiteState');
      await (await build()).moodle();
      await (await build()).moodle();
      expect(read).toHaveBeenCalledTimes(1);
      read.mockRestore();
    });

    it('still builds a client for an invalid credential with a session', async () => {
      await sessionOnly('invalid');
      await (await build()).moodle();
      expect(created).toHaveLength(1);
    });

    it('caps both channels’ budgets when asked to', async () => {
      await storeCredential();
      await addSession();
      const props = { userId, scopes: ['moodle:read' as const], source: 'Scheduled sweep' };
      await (await buildServiceContext(env, execCtx(), props, { maxCalls: 12 })).moodle();
      expect([tokenOf().maxCalls, sessionOf().maxCalls]).toEqual([12, 12]);
      await (await buildServiceContext(env, execCtx(), props)).moodle();
      expect(sessionOf(1).maxCalls).toBeUndefined(); // the client's own default applies
    });

    it('remembers for everyone that the mobile web service turned out to be off', async () => {
      await serviceOn();
      await storeCredential();
      await addSession();
      await (await build()).moodle();
      await options().onMobileServiceOff?.();
      expect(await store.getSiteState('mobile_service')).toBe('0');
      await (await build()).moodle();
      expect(options(1).mobileService).toBe(false);
    });
  });

  describe('token channel', () => {
    beforeEach(serviceOn);

    it('marks the credential invalid when Moodle rejects its only channel', async () => {
      await storeCredential();
      await (await build()).moodle();
      await tokenOf().onTokenInvalid?.('t'.repeat(32));
      expect(await store.getCredential(userId)).toMatchObject({ status: 'invalid' });
      expect((await store.getCredential(userId))?.lastError).toBeTruthy();
    });

    it('drops only the rejected token while a session is left', async () => {
      await storeCredential();
      await addSession();
      await (await build()).moodle();
      await tokenOf().onTokenInvalid?.('t'.repeat(32));
      expect(await store.getCredential(userId)).toMatchObject({ status: 'active', tokenEnc: null, lastError: null });
      expect((await store.getCredential(userId))?.sessionEnc).not.toBeNull();
    });

    it('does not invalidate a credential that holds another token by now (stale rejection)', async () => {
      await storeCredential();
      await (await build()).moodle();
      await tokenOf().onTokenInvalid?.('e'.repeat(32)); // not the stored token
      expect(await store.getCredential(userId)).toMatchObject({ status: 'active', lastError: null });
    });

    describe('with a Moodle web session', () => {
      const NEW = 'c'.repeat(32);
      afterEach(() => vi.unstubAllGlobals());

      async function withSession(status: 'active' | 'invalid') {
        await storeCredential({ status });
        await addSession();
        const web = fakeMoodleWeb({ token: NEW, live: new Set([LIVE]) });
        vi.stubGlobal('fetch', vi.fn(web.fetch));
        return web;
      }

      it('renews a rejected token from the session (launch.php only, never an autologin)', async () => {
        const web = await withSession('active');
        await (await build()).moodle();
        const charged = vi.fn(web.fetch); // the client's own budgeted fetch
        expect(await tokenOf().renewToken?.(charged)).toBe(NEW);
        expect(charged).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(web.requests.map((r) => r.path)).toEqual(['/admin/tool/mobile/launch.php']);
        const cred = await store.getCredential(userId);
        expect(cred).toMatchObject({ status: 'active', tokenHint: NEW.slice(-4) });
        expect(cred?.renewedAt).not.toBeNull();
        // credential health only: an on-demand renewal is no activity of its own
        await Promise.all(deferred);
        expect(await counters()).toEqual([{ metric: 'renew_renewed', dim: '', value: 1 }]);
      });

      it('renews an invalid credential’s token too', async () => {
        const web = await withSession('invalid');
        await (await build()).moodle();
        expect(await tokenOf().renewToken?.(web.fetch)).toBe(NEW);
        expect(await store.getCredential(userId)).toMatchObject({ status: 'active', lastError: null });
      });

      it('gives nothing when the session has ended, and forgets it', async () => {
        const web = await withSession('invalid');
        web.state.live.clear();
        await (await build()).moodle();
        expect(await tokenOf().renewToken?.(web.fetch)).toBeNull();
        expect((await store.getCredential(userId))?.sessionEnc).toBeNull();
        created.length = 0;
        await expect((await build()).moodle()).rejects.toBeInstanceOf(NeedsReconnect);
        expect(created).toHaveLength(0);
      });
    });

    it('opens the session right after a connect that stored a private token, and only then', async () => {
      await storeCredential();
      const rt = await getRuntime(env);
      const user = (await store.getUser(userId))!;
      const web = fakeMoodleWeb({ token: 'c'.repeat(32) });
      vi.stubGlobal('fetch', vi.fn(web.fetch));
      await startRenewal(rt, user, await store.getCredential(userId));
      expect(web.requests).toHaveLength(0); // no private token
      const prev = (await store.getCredential(userId))!;
      await store.putCredential({ ...prev, privateTokenEnc: await rt.key.encrypt('Priv4te1') });
      await startRenewal(rt, user, await store.getCredential(userId));
      expect(web.requests.map((r) => r.path)).toEqual([
        '/webservice/rest/server.php',
        '/admin/tool/mobile/autologin.php',
        '/admin/tool/mobile/launch.php',
      ]);
      const cred = await store.getCredential(userId);
      expect(cred?.sessionEnc).not.toBeNull();
      await startRenewal(rt, user, cred);
      expect(web.requests).toHaveLength(3); // a session exists already
      expect((await store.getUser(userId))?.lastSeenAt).toBe(user.lastSeenAt);
      expect(await counters()).toEqual([{ metric: 'renew_renewed', dim: '', value: 1 }]); // one renewal, no activity
      vi.unstubAllGlobals();
    });

    it('refreshes lastOkAt lazily, at most every 10 minutes', async () => {
      await storeCredential({ lastOkAt: Date.now() - 2 * LAST_OK_INTERVAL_MS });
      await (await build()).moodle();
      deferred.length = 0;
      tokenOf().onSuccess?.();
      expect(deferred).toHaveLength(1);
      await Promise.all(deferred);
      const cred = await store.getCredential(userId);
      expect(Date.now() - (cred?.lastOkAt ?? 0)).toBeLessThan(5000);

      await (await build()).moodle(); // lastOkAt is fresh now
      deferred.length = 0;
      tokenOf(1).onSuccess?.();
      expect(deferred).toHaveLength(0);
    });
  });

  it('never opens a session while the mobile web service is off', async () => {
    await storeCredential();
    const rt = await getRuntime(env);
    const user = (await store.getUser(userId))!;
    const prev = (await store.getCredential(userId))!;
    await store.putCredential({ ...prev, privateTokenEnc: await rt.key.encrypt('Priv4te1') });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await startRenewal(rt, user, await store.getCredential(userId));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  describe('web channel', () => {
    it('stores a rotated cookie and a new sesskey', async () => {
      await sessionOnly();
      await (await build()).moodle();
      const { session } = sessionOf();
      await session.onUpdate?.({ cookie: 'MoodleSession=rotated02' });
      await session.onUpdate?.({ sesskey: 'Sk00000002' });
      const cred = await store.getCredential(userId);
      expect(await plain(cred?.sessionEnc)).toBe('MoodleSession=rotated02');
      expect(await plain(cred?.sesskeyEnc)).toBe('Sk00000002');
    });

    it('forgets an ended session, asks for a reconnect and counts it', async () => {
      await sessionOnly();
      await (await build()).moodle();
      await sessionOf().session.onEnded?.();
      expect(await store.getCredential(userId)).toMatchObject({
        sessionEnc: null,
        sesskeyEnc: null,
        status: 'invalid',
        lastError: 'The Moodle session ended. Reconnect to continue.',
      });
      expect(await counters()).toEqual([{ metric: 'renew_ended', dim: '', value: 1 }]);
      created.length = 0;
      await expect((await build()).moodle()).rejects.toBeInstanceOf(NeedsReconnect);
    });

    it('stays active after the session ends while a usable token remains', async () => {
      await serviceOn();
      await storeCredential();
      await addSession();
      await (await build()).moodle();
      await sessionOf().session.onEnded?.();
      expect(await store.getCredential(userId)).toMatchObject({ sessionEnc: null, status: 'active' });
    });

    it('does not count the token once the service turned out to be off', async () => {
      await serviceOn();
      await storeCredential();
      await addSession();
      await (await build()).moodle();
      await options().onMobileServiceOff?.();
      await sessionOf().session.onEnded?.();
      expect(await store.getCredential(userId)).toMatchObject({ sessionEnc: null, status: 'invalid' });
    });

    it('stamps a successful call lazily and brings an invalid credential back', async () => {
      await sessionOnly('invalid');
      await (await build()).moodle();
      deferred.length = 0;
      sessionOf().onSuccess?.();
      await Promise.all(deferred);
      const cred = await store.getCredential(userId);
      expect(cred).toMatchObject({ status: 'active', lastError: null });
      expect(Date.now() - (cred?.sessionOkAt ?? 0)).toBeLessThan(5000);
      expect(cred?.lastOkAt).toBe(cred?.sessionOkAt);

      await (await build()).moodle(); // fresh now
      deferred.length = 0;
      sessionOf(1).onSuccess?.();
      expect(deferred).toHaveLength(0);
    });
  });
});

describe('makeMoodleFactory', () => {
  it('builds clients by user id for the file routes', async () => {
    await serviceOn();
    await storeCredential();
    const make = makeMoodleFactory(env, execCtx());
    await make(userId);
    expect(options()).toMatchObject({ moodleUserId: 1001 });
    await expect(make(4242)).rejects.toBeInstanceOf(NotFound);
  });
});

describe('ctx.mail', () => {
  const props = () => ({ userId, scopes: ['moodle:read' as const], source: 'Claude' });
  let mailEnv: Env;

  async function storeMail(over: { status?: 'active' | 'invalid'; lastError?: string | null } = {}) {
    const rt = await getRuntime(mailEnv);
    await store.putMailCredential({
      userId,
      address: 'taro@akane.waseda.jp',
      googleSub: 'sub-1',
      refreshEnc: await rt.key.encrypt('rt-old'),
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      status: over.status ?? 'active',
      connectedAt: 1,
      lastUsedAt: null,
      lastError: over.lastError ?? null,
      idleTriedAt: null,
    });
  }

  beforeEach(() => {
    mailEnv = { ...env, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' } as Env;
    // Google rejects every refresh token
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is built only for contexts that serve mail (no D1 read elsewhere)', async () => {
    await storeMail();
    const rt = await getRuntime(mailEnv);
    const read = vi.spyOn(rt.store, 'getMailCredential');
    const plain = await buildServiceContext(mailEnv, execCtx(), props());
    expect(plain.mail).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    const withMail = await buildServiceContext(mailEnv, execCtx(), props(), { mail: true });
    expect((await withMail.mail?.())?.address).toBe('taro@akane.waseda.jp');
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();
  });

  it('an ended connection asks to reconnect mail with its reason', async () => {
    await storeMail({ status: 'invalid', lastError: 'Disconnected after 90 days without use.' });
    const ctx = await buildServiceContext(mailEnv, execCtx(), props(), { mail: true });
    const err = await ctx.mail?.().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailNeedsReconnect);
    expect((err as Error).message).toBe('Disconnected after 90 days without use.');
  });

  it('a rejected refresh token marks the row invalid, unless the user reconnected meanwhile', async () => {
    await storeMail();
    const ctx = await buildServiceContext(mailEnv, execCtx(), props(), { mail: true });
    const api = await ctx.mail?.();
    await storeMail(); // a reconnect: a new encryption of a new token
    await expect(api?.get('labels')).rejects.toBeInstanceOf(MailNeedsReconnect);
    expect((await store.getMailCredential(userId))?.status).toBe('active');

    const again = await buildServiceContext(mailEnv, execCtx(), props(), { mail: true });
    await expect((await again.mail?.())?.get('labels')).rejects.toBeInstanceOf(MailNeedsReconnect);
    expect(await store.getMailCredential(userId)).toMatchObject({
      status: 'invalid',
      lastError: 'Google rejected the stored mail authorization.',
    });
  });
});
