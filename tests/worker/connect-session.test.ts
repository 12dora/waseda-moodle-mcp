/** Connecting with a Moodle web session: console connect, extension hand-off and silent refresh. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeedsReconnect } from '../../src/core/errors';
import { identifySession } from '../../src/core/moodle/web/identify';
import { createApi } from '../../src/worker/api';
import { resetRateLimitMemory, SESSION_COOKIE } from '../../src/worker/auth';
import { getRuntime } from '../../src/worker/context';
import type { Env } from '../../src/worker/env';
import { resetSiteFlagMemory } from '../../src/worker/site-flag';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

vi.mock('../../src/core/moodle/web/identify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/moodle/web/identify')>()),
  identifySession: vi.fn(),
}));

const ORIGIN = 'https://wasemoodle.example.com';
const EXTENSION = 'chrome-extension://abcdef';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 17)));
const TOKEN = 'a'.repeat(32);

/** Cookie value -> the Moodle user it belongs to; any other value is an ended session. */
const SESSIONS: Record<string, { id: number; name: string }> = {
  sessionvalue000000taro1: { id: 1001, name: 'Taro Yamada' },
  sessionvalue000000taro2: { id: 1001, name: 'Taro Yamada' },
  sessionvalue00000hanako: { id: 1002, name: 'Hanako Sato' },
  sessionvalue00000outside: { id: 9999, name: 'Alice' },
};
const TARO = 'sessionvalue000000taro1';
const TARO_AGAIN = 'sessionvalue000000taro2';
const HANAKO = 'sessionvalue00000hanako';
const ENDED = 'sessionvalue000000ended';

interface Body {
  error: { code: string; message: string };
  user: { id: number; moodleUserId: number };
  credential: Record<string, unknown> | null;
  created: boolean;
  status: string;
  code: string;
}

let testD1: TestD1;
let env: Env;
let store: D1Store;
let pending: Promise<unknown>[];
let ipCounter = 0;
const app = createApi();

const execCtx = () =>
  ({
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  }) as unknown as ExecutionContext;

async function post(path: string, body: unknown, opts: { cookie?: string; ip?: string } = {}): Promise<Response> {
  const extension = path !== '/api/connect';
  const headers = new Headers({
    'Content-Type': 'application/json',
    'CF-Connecting-IP': opts.ip ?? `198.51.100.${++ipCounter % 250}`,
    Origin: extension ? EXTENSION : ORIGIN,
  });
  if (!extension) headers.set('X-WMM', '1');
  if (opts.cookie) headers.set('Cookie', opts.cookie);
  const request = new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const res = await app.fetch(request, env, execCtx());
  await Promise.all(pending.splice(0));
  return res;
}

const json = async (res: Response) => (await res.json()) as Body;
const sessionCookieOf = (res: Response) => (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

async function me(cookie: string): Promise<Body> {
  const res = await app.fetch(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } }), env, execCtx());
  return json(res);
}

async function storedCookie(moodleUserId: number): Promise<string | null> {
  const user = await store.getUserByMoodleId(moodleUserId);
  const enc = user ? (await store.getCredential(user.id))?.sessionEnc : null;
  return enc ? (await getRuntime(env)).key.decrypt(enc) : null;
}

beforeEach(() => {
  resetRateLimitMemory();
  resetSiteFlagMemory();
  pending = [];
  testD1 = createTestD1();
  env = {
    DB: testD1.db,
    OAUTH_KV: new MemoryKV().asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: ORIGIN,
    REGISTRATION: 'allowlist',
    ALLOWED_MOODLE_USERIDS: '1001,1002',
  } as Env;
  store = createD1Store(env.DB);
  vi.mocked(identifySession)
    .mockReset()
    .mockImplementation(async (_fetch, cookie) => {
      const who = SESSIONS[cookie.replace('MoodleSession=', '')];
      if (!who) throw new NeedsReconnect('The Moodle session has ended.');
      return { moodleUserId: who.id, fullname: who.name, lang: 'ja', sesskey: 'Sk00000001', cookie };
    });
  // the app token calls: the service answers (a sign-in with a launch link)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ siteurl: 'https://wsdmoodle.waseda.jp', userid: 1001, fullname: 'Taro Yamada', lang: 'ja' }),
    ),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/connect with a session', () => {
  it('signs in, stores the session encrypted and reports an active connection', async () => {
    const res = await post('/api/connect', { session: `MoodleSession=${TARO}`, via: 'paste' });
    expect(res.status).toBe(200);
    expect(sessionCookieOf(res)).toContain(`${SESSION_COOKIE}=`);
    const body = await json(res);
    expect(body).toMatchObject({ created: true, user: { moodleUserId: 1001 } });
    expect(body.credential).toMatchObject({ status: 'active', connectedVia: 'paste', lastError: null });
    expect(body.credential?.sessionOkAt).toEqual(expect.any(String));
    expect(await storedCookie(1001)).toBe(`MoodleSession=${TARO}`);
    const row = testD1.sqlite.prepare('SELECT * FROM credentials').get();
    expect(String(row?.session_enc)).not.toContain(TARO);
    expect(row?.token_enc).toBeNull();
    expect(JSON.stringify(body)).not.toContain(TARO);
    expect((await me(sessionCookieOf(res))).credential).toMatchObject({ status: 'active' });
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled(); // no token, no token call
  });

  it('takes the bare cookie value, defaulting to a paste, and the extension as origin', async () => {
    expect((await json(await post('/api/connect', { session: TARO }))).credential?.connectedVia).toBe('paste');
    const res = await post('/api/connect', { session: TARO_AGAIN, via: 'extension' });
    expect(await json(res)).toMatchObject({ created: false, credential: { connectedVia: 'extension' } });
    expect(await storedCookie(1001)).toBe(`MoodleSession=${TARO_AGAIN}`);
  });

  it('rejects other origins of a session, text that is none, and an ended one', async () => {
    for (const via of ['bookmarklet', 'stdio']) {
      expect((await post('/api/connect', { session: TARO, via })).status).toBe(400);
    }
    const bad = await post('/api/connect', { session: 'not a cookie' });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe('invalid_input');
    const ended = await post('/api/connect', { session: ENDED });
    expect(ended.status).toBe(409);
    expect((await json(ended)).error.code).toBe('needs_reconnect');
    expect(ended.headers.get('Set-Cookie')).toBeNull();
    expect(await store.getUserByMoodleId(1001)).toBeNull();
  });

  it('asks before a pasted cookie of another Moodle account replaces the signed-in one', async () => {
    const cookie = sessionCookieOf(await post('/api/connect', { session: TARO }));
    const refused = await post('/api/connect', { session: HANAKO, via: 'paste' }, { cookie });
    expect(refused.status).toBe(409);
    const asked = { error: { code: 'account_switch' }, account: { fullname: 'Hanako Sato' } };
    expect(await json(refused)).toMatchObject(asked);
    expect(refused.headers.get('Set-Cookie')).toBeNull();
    const same = await post('/api/connect', { session: TARO_AGAIN, via: 'paste' }, { cookie });
    expect(same.status).toBe(200);
    const switched = await post('/api/connect', { session: HANAKO, via: 'paste', switchAccount: true }, { cookie });
    expect((await json(switched)).user.moodleUserId).toBe(1002);
  });

  it('applies the registration policy', async () => {
    expect((await post('/api/connect', { session: 'sessionvalue00000outside' })).status).toBe(403);
    expect(await store.getUserByMoodleId(9999)).toBeNull();
  });

  it('turns the mobile web service flag on when Moodle answers for a launch token', async () => {
    expect(await store.getSiteState('mobile_service')).toBe('0');
    const res = await post('/api/connect', { launch: TOKEN, via: 'paste' });
    expect((await json(res)).credential).toMatchObject({ status: 'active', sessionOkAt: null });
    expect(await store.getSiteState('mobile_service')).toBe('1');
  });

  it('shows a token-only connection as needing a reconnect while the service is off', async () => {
    const res = await post('/api/connect', { launch: TOKEN, via: 'paste' });
    resetSiteFlagMemory();
    await store.putSiteState('mobile_service', '0', Date.now());
    const credential = (await me(sessionCookieOf(res))).credential;
    expect(credential).toMatchObject({ status: 'invalid' });
    expect(credential?.lastError).toMatch(/browser extension/);
  });
});

describe('hand-off with a session', () => {
  const handoff = (body: unknown) => post('/api/connect/handoff', body);

  it('checks the format without calling Moodle and keeps the session encrypted', async () => {
    expect((await handoff({ session: 'short', via: 'extension' })).status).toBe(400);
    expect((await handoff({ via: 'extension' })).status).toBe(400);
    const res = await handoff({ session: TARO, via: 'extension' });
    expect(res.status).toBe(200);
    expect(identifySession).not.toHaveBeenCalled();
    const rows = testD1.sqlite.prepare('SELECT payload_enc FROM handoffs').all();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.payload_enc)).not.toContain(TARO);

    const connected = await post('/api/connect', { code: (await json(res)).code });
    expect(await json(connected)).toMatchObject({ credential: { connectedVia: 'extension', status: 'active' } });
  });

  it('asks before switching to another account', async () => {
    const first = await post('/api/connect', { session: TARO });
    const { code } = await json(await handoff({ session: HANAKO, via: 'extension' }));
    const cookie = sessionCookieOf(first);
    const refused = await post('/api/connect', { code }, { cookie });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.code).toBe('account_switch');
    const switched = await post('/api/connect', { code, switchAccount: true }, { cookie });
    expect((await json(switched)).user.moodleUserId).toBe(1002);
  });
});

describe('extension refresh with a session', () => {
  const refresh = (session: string, ip?: string) => post('/api/extension/refresh', { session }, { ip });

  it('only updates an existing account', async () => {
    const res = await refresh(TARO);
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await store.getUserByMoodleId(1001)).toBeNull();
  });

  it('replaces the stored session silently, so no reconnect is needed', async () => {
    await post('/api/connect', { session: TARO });
    expect(await json(await refresh(TARO))).toEqual({ status: 'unchanged' });
    const user = await store.getUserByMoodleId(1001);
    const ended = { sessionEnc: null, status: 'invalid' as const, lastError: 'The Moodle session ended.' };
    await store.updateCredentialStatus(user?.id ?? 0, ended);
    expect(await json(await refresh(TARO_AGAIN))).toEqual({ status: 'updated' });
    expect(await storedCookie(1001)).toBe(`MoodleSession=${TARO_AGAIN}`);
    expect(await store.getCredential(user?.id ?? 0)).toMatchObject({ status: 'active', lastError: null });
  });

  it('answers an ended session with needs_reconnect and keeps the stored one', async () => {
    await post('/api/connect', { session: TARO });
    const res = await refresh(ENDED);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('needs_reconnect');
    expect(await storedCookie(1001)).toBe(`MoodleSession=${TARO}`);
  });

  it('limits each account, not each cookie, to 6 per hour', async () => {
    await post('/api/connect', { session: TARO });
    await post('/api/connect', { session: HANAKO });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await refresh(i % 2 ? TARO : TARO_AGAIN)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429, 429]);
    expect((await refresh(HANAKO)).status).toBe(200); // another account is not affected
  });

  it('limits each cookie to 6 per hour before Moodle is asked (an ended one too)', async () => {
    const identify = vi.mocked(identifySession);
    const before = identify.mock.calls.length;
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await refresh(ENDED)).status);
    expect(statuses).toEqual([409, 409, 409, 409, 409, 409, 429, 429]);
    expect(identify.mock.calls.length - before).toBe(6);
  });
});
