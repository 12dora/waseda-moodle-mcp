import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/core/crypto';
import { NeedsReconnect } from '../../src/core/errors';
import { cancelAction, confirmAction, listActionRecords } from '../../src/core/services/actions';
import { listCourses } from '../../src/core/services/courses';
import { getDueItems } from '../../src/core/services/due';
import { streamDownload, streamUpload } from '../../src/core/services/files';
import { createApi } from '../../src/worker/api';
import { resolveApiKey, SESSION_COOKIE } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { createD1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

vi.mock('../../src/core/services/due', () => ({ getDueItems: vi.fn() }));
vi.mock('../../src/core/services/courses', () => ({ listCourses: vi.fn() }));
vi.mock('../../src/core/services/actions', () => ({
  confirmAction: vi.fn(),
  cancelAction: vi.fn(),
  listActionRecords: vi.fn(),
}));
vi.mock('../../src/core/services/files', () => ({ streamDownload: vi.fn(), streamUpload: vi.fn() }));

const ORIGIN = 'https://wasemoodle.example.com';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

type Row = Record<string, unknown>;

/** The response fields these tests read (a deliberately loose view of the JSON bodies). */
interface Body {
  error: { code: string; message: string };
  user: { id: number; moodleUserId: number; settings: Row };
  credential: Row | null;
  created: boolean;
  settings: Row;
  key: { id: string; prefix: string; createdAt: string; scopes: string[] };
  secret: string;
  status: string;
  redirectTo: string;
  code: string;
  launchUrl: string;
  version: unknown;
  authRequest: { clientId: string };
  scopes: string[];
  clientName: string;
}

interface GrantRec {
  id: string;
  clientId: string;
  userId: string;
  scope: string[];
  metadata: unknown;
  createdAt: number;
}

function fakeProvider() {
  const grants: GrantRec[] = [];
  const completed: Array<Record<string, unknown>> = [];
  const state = { parseError: null as unknown };
  const authRequest = {
    responseType: 'code',
    clientId: 'client-1',
    redirectUri: 'https://client.example.org/cb',
    scope: ['moodle:read', 'moodle:write', 'unrelated'],
    state: 'st-1',
    issuer: ORIGIN,
  };
  const provider = {
    parseAuthRequest: vi.fn(async () => {
      if (state.parseError) throw state.parseError;
      return authRequest;
    }),
    describeConsent: vi.fn(async (r: typeof authRequest) => ({
      clientId: r.clientId,
      clientName: 'Claude',
      clientUri: 'https://claude.example.org',
      redirectUri: r.redirectUri,
      redirectHost: 'client.example.org',
      redirectIsLoopback: false,
      scope: r.scope,
    })),
    completeAuthorization: vi.fn(async (opts: Record<string, unknown>) => {
      completed.push(opts);
      return { redirectTo: 'https://client.example.org/cb?code=abc&state=st-1' };
    }),
    listUserGrants: vi.fn(async (userId: string) => ({ items: grants.filter((g) => g.userId === userId) })),
    revokeGrant: vi.fn(async (id: string, userId: string) => {
      const i = grants.findIndex((g) => g.id === id && g.userId === userId);
      if (i >= 0) grants.splice(i, 1);
    }),
  };
  return { provider, grants, completed, state, authRequest };
}

let testD1: TestD1;
let kv: MemoryKV;
let env: Env;
let fp: ReturnType<typeof fakeProvider>;
let pending: Promise<unknown>[];
let ipCounter = 0;

function handoffRows(): Row[] {
  return testD1.sqlite.prepare('SELECT * FROM handoffs').all() as Row[];
}

function nextIp(prefix: string): string {
  ipCounter = (ipCounter % 250) + 1;
  return `${prefix}.${ipCounter}`;
}
const app = createApi();

function makeEnv(over: Partial<Env> = {}): Env {
  testD1 = createTestD1();
  const { db } = testD1;
  kv = new MemoryKV();
  fp = fakeProvider();
  return {
    DB: db,
    OAUTH_KV: kv.asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: ORIGIN,
    REGISTRATION: 'allowlist',
    ALLOWED_MOODLE_USERIDS: '1001',
    OAUTH_PROVIDER: fp.provider as unknown as Env['OAUTH_PROVIDER'],
    ...over,
  };
}

const execCtx = () =>
  ({
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  }) as unknown as ExecutionContext;

async function call(path: string, init: RequestInit & { cookie?: string; mutating?: boolean } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('Cookie', init.cookie);
  const method = init.method ?? 'GET';
  if (init.mutating ?? !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!headers.has('X-WMM')) headers.set('X-WMM', '1');
    if (!headers.has('Origin')) headers.set('Origin', ORIGIN);
  }
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  // every request comes from its own client IP so the per-IP abuse limiters never interfere between tests
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', nextIp('198.51.100'));
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, execCtx());
  await Promise.all(pending.splice(0));
  return res;
}

const post = (path: string, body: unknown, cookie?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(body), cookie });

async function connect(token = TOKEN_A): Promise<{ cookie: string; body: Body }> {
  const res = await post('/api/connect', { launch: token, via: 'paste' });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('Set-Cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return { cookie, body: await res.json() };
}

function stubMoodle(userId = 1001) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ siteurl: 'https://wsdmoodle.waseda.jp', userid: userId, fullname: 'Taro Yamada', lang: 'ja' }),
    ),
  );
}

beforeEach(() => {
  pending = [];
  env = makeEnv();
  stubMoodle();
  vi.mocked(getDueItems).mockReset();
  vi.mocked(listCourses).mockReset();
  vi.mocked(confirmAction).mockReset();
  vi.mocked(cancelAction).mockReset();
  vi.mocked(listActionRecords).mockReset();
  vi.mocked(streamDownload).mockReset();
  vi.mocked(streamUpload).mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('public endpoints', () => {
  it('GET /health and unknown paths', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const nf = await call('/api/nope');
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as Body).error.code).toBe('not_found');
  });

  it('GET /api/config exposes the public settings', async () => {
    const cfg = (await (await call('/api/config')).json()) as Body;
    expect(cfg).toMatchObject({
      publicUrl: ORIGIN,
      mcpUrl: `${ORIGIN}/mcp`,
      moodleUrl: 'https://wsdmoodle.waseda.jp',
      registration: 'allowlist',
      extensionUrl: null,
    });
    expect(cfg.launchUrl).toContain('passport=wmm');
    expect(cfg.launchUrl).toContain('confirmed=1');
    expect(typeof cfg.version).toBe('string');

    env = makeEnv({ REGISTRATION: 'open', EXTENSION_URL: 'https://example.com/ext', PUBLIC_URL: `${ORIGIN}/` });
    const cfg2 = (await (await call('/api/config')).json()) as Body;
    expect(cfg2).toMatchObject({ registration: 'open', extensionUrl: 'https://example.com/ext', publicUrl: ORIGIN });
  });

  it('never caches API responses', async () => {
    expect((await call('/api/config')).headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('CSRF', () => {
  it('rejects state-changing requests without X-WMM or from another origin', async () => {
    const noHeader = await call('/api/logout', { method: 'POST', mutating: false });
    expect(noHeader.status).toBe(403);
    expect(((await noHeader.json()) as Body).error.code).toBe('forbidden');

    const badOrigin = await call('/api/logout', { method: 'POST', headers: { Origin: 'https://evil.example.org' } });
    expect(badOrigin.status).toBe(403);

    const ok = await call('/api/logout', { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('allows a missing Origin header (non-browser clients) when X-WMM is present', async () => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/logout`, { method: 'POST', headers: { 'X-WMM': '1' } }),
      env,
      execCtx(),
    );
    expect(res.status).toBe(200);
  });
});

describe('connect, session and account', () => {
  it('connects, sets a hardened cookie and serves /api/me', async () => {
    const res = await post('/api/connect', { launch: TOKEN_A, via: 'paste', passport: 'wmm' });
    expect(res.status).toBe(200);
    const sc = res.headers.get('Set-Cookie') ?? '';
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(sc).toContain(a);
    const body = (await res.json()) as Body;
    expect(body.created).toBe(true);
    expect(body.user).toMatchObject({ moodleUserId: 1001, fullname: 'Taro Yamada' });
    expect(body.credential).toMatchObject({ status: 'active', connectedVia: 'paste', tokenHint: 'aaaa' });

    const me = await call('/api/me', { cookie: sc.split(';')[0] });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as Body;
    expect(meBody.user.moodleUserId).toBe(1001);
    expect(meBody.credential?.status).toBe('active');
  });

  it('requires a session for /api/me', async () => {
    const res = await call('/api/me');
    expect(res.status).toBe(401);
    expect(((await res.json()) as Body).error.code).toBe('unauthorized');
    expect((await call('/api/me', { cookie: `${SESSION_COOKIE}=bogus` })).status).toBe(401);
  });

  it('refuses unregistered Moodle users under the allowlist policy', async () => {
    env = makeEnv({ ALLOWED_MOODLE_USERIDS: '' });
    const res = await post('/api/connect', { launch: TOKEN_A, via: 'paste' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Body).error.code).toBe('forbidden');
  });

  it('validates the connect body', async () => {
    expect((await post('/api/connect', { via: 'paste' })).status).toBe(400);
    expect((await post('/api/connect', { launch: TOKEN_A, via: 'stdio' })).status).toBe(400);
    expect((await post('/api/connect', { launch: TOKEN_A, via: 'bookmarklet' })).status).toBe(400);
    const bad = await call('/api/connect', { method: 'POST', body: '{nope' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Body).error.code).toBe('invalid_input');
  });

  it('logout removes the session', async () => {
    const { cookie } = await connect();
    expect((await call('/api/logout', { method: 'POST', cookie })).status).toBe(200);
    expect((await call('/api/me', { cookie })).status).toBe(401);
  });

  it('DELETE /api/me revokes every OAuth grant and deletes the user', async () => {
    const { cookie, body } = await connect();
    const uid = String(body.user.id);
    for (const id of ['g1', 'g2']) {
      fp.grants.push({ id, clientId: 'c', userId: uid, scope: ['moodle:read'], metadata: {}, createdAt: 1 });
    }
    fp.grants.push({ id: 'other', clientId: 'c', userId: '999', scope: [], metadata: {}, createdAt: 1 });

    const res = await call('/api/me', { method: 'DELETE', cookie });
    expect(res.status).toBe(200);
    expect(fp.grants.map((g) => g.id)).toEqual(['other']);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(await createD1Store(env.DB).getUser(body.user.id)).toBeNull();
    expect((await call('/api/me', { cookie })).status).toBe(401);
  });

  it('PATCH /api/settings validates and persists', async () => {
    const { cookie } = await connect();
    const ok = await call('/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ writeMode: 'console', hiddenCourseIds: [5, 6], uiLang: 'ja' }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Body).settings).toEqual({
      writeMode: 'console',
      hiddenCourseIds: [5, 6],
      uiLang: 'ja',
    });

    const partial = await call('/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ uiLang: 'en' }) });
    expect(((await partial.json()) as Body).settings).toEqual({
      writeMode: 'console',
      hiddenCourseIds: [5, 6],
      uiLang: 'en',
    });

    for (const bad of [
      { writeMode: 'always' },
      { hiddenCourseIds: ['x'] },
      { hiddenCourseIds: 'all' },
      { uiLang: 'fr' },
    ]) {
      const r = await call('/api/settings', { method: 'PATCH', cookie, body: JSON.stringify(bad) });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const me = (await (await call('/api/me', { cookie })).json()) as Body;
    expect(me.user.settings.writeMode).toBe('console');
  });
});

describe('extension refresh', () => {
  const refresh = (token: string, ip: string) =>
    call('/api/extension/refresh', {
      method: 'POST',
      body: JSON.stringify({ launch: token }),
      headers: { 'CF-Connecting-IP': ip, Origin: 'chrome-extension://abcdef' },
      mutating: false,
    });
  const freshIp = () => nextIp('203.0.113');

  it('answers preflight with CORS *', async () => {
    const res = await call('/api/extension/refresh', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('404s for unknown users, with CORS, and without needing a cookie or X-WMM', async () => {
    const res = await refresh(TOKEN_A, freshIp());
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(((await res.json()) as Body).error.code).toBe('not_found');
  });

  it('reports unchanged / updated for a known user', async () => {
    await connect(TOKEN_A);
    const ip = freshIp();
    const same = await refresh(TOKEN_A, ip);
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ status: 'unchanged' });
    const changed = await refresh(TOKEN_B, ip);
    expect(await changed.json()).toEqual({ status: 'updated' });
  });

  it('limits to 10 per hour per IP and keeps KV writes low', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await refresh(TOKEN_A, ip)).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(kv.ops.put).toBe(8);
  });
});

describe('token hand-off', () => {
  const MOODLE_ORIGIN = 'https://wsdmoodle.waseda.jp';
  const handoff = (body: unknown, origin: string | null = MOODLE_ORIGIN, ip = nextIp('192.0.2')) =>
    call('/api/connect/handoff', {
      method: 'POST',
      body: JSON.stringify(body),
      mutating: false,
      headers: { ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': ip },
    });

  it('stores an encrypted payload and returns a short-lived code, with credential-less CORS', async () => {
    const res = await handoff({ launch: TOKEN_A, via: 'bookmarklet', passport: 'abc' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(MOODLE_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(res.headers.get('Vary')).toContain('Origin');
    const { code } = (await res.json()) as Body;
    expect(code).toMatch(/^hnd_/);

    const rows = handoffRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload_enc).not.toContain(TOKEN_A);
    expect(rows[0]?.code_hash).toBe(await sha256Hex(code));
    expect((rows[0]?.expires_at as number) - (rows[0]?.created_at as number)).toBe(120_000);
  });

  it('answers the preflight for Moodle and extension origins only', async () => {
    for (const origin of [MOODLE_ORIGIN, 'chrome-extension://abcdef', 'moz-extension://1234']) {
      const res = await call('/api/connect/handoff', { method: 'OPTIONS', headers: { Origin: origin } });
      expect(res.status, origin).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
    const denied = await call('/api/connect/handoff', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.org' },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await handoff({ launch: TOKEN_A, via: 'bookmarklet' }, 'https://evil.example.org')).status).toBe(403);
  });

  it('checks the launch format without calling Moodle and validates via', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();
    expect((await handoff({ launch: 'not a token!', via: 'bookmarklet' })).status).toBe(400);
    expect((await handoff({ launch: TOKEN_A, via: 'paste' })).status).toBe(400);
    expect((await handoff({ via: 'extension' })).status).toBe(400);
    expect((await handoff({ launch: TOKEN_A, via: 'extension' })).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is rate limited per IP', async () => {
    const ip = nextIp('192.0.2');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await handoff({ launch: TOKEN_A, via: 'bookmarklet' }, null, ip)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('connect redeems the code once and records how the token arrived', async () => {
    const { code } = (await (await handoff({ launch: TOKEN_A, via: 'bookmarklet', passport: 'wmm' })).json()) as Body;
    const res = await post('/api/connect', { code });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.created).toBe(true);
    expect(body.credential).toMatchObject({ connectedVia: 'bookmarklet', tokenHint: 'aaaa' });
    expect(res.headers.get('Set-Cookie')).toContain(SESSION_COOKIE);
    expect(handoffRows()).toHaveLength(0);

    const again = await post('/api/connect', { code });
    expect(again.status).toBe(400);
    expect(((await again.json()) as Body).error.code).toBe('invalid_input');
  });

  it('rejects expired and unknown codes', async () => {
    const store = createD1Store(env.DB);
    await store.putHandoff({
      codeHash: await sha256Hex('hnd_old'),
      payloadEnc: 'x',
      createdAt: 1,
      expiresAt: Date.now() - 1,
    });
    expect((await post('/api/connect', { code: 'hnd_old' })).status).toBe(400);
    expect((await post('/api/connect', { code: 'hnd_unknown' })).status).toBe(400);
    expect(handoffRows()).toHaveLength(0); // the expired row was consumed too
  });
});

describe('framing protection', () => {
  it('forbids framing of API answers and the authorize redirect', async () => {
    for (const path of ['/api/config', '/api/me', '/authorize?response_type=code&client_id=c']) {
      const res = await call(path);
      expect(res.headers.get('X-Frame-Options'), path).toBe('DENY');
      expect(res.headers.get('Content-Security-Policy'), path).toBe("frame-ancestors 'none'");
    }
  });
});

describe('Moodle data routes', () => {
  it('GET /api/due passes a console context and validated options', async () => {
    const { cookie } = await connect();
    vi.mocked(getDueItems).mockResolvedValue({ items: [] } as never);
    const res = await call('/api/due?days=7&course_id=42', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    const [ctx, opts] = vi.mocked(getDueItems).mock.calls[0] ?? [];
    expect(opts).toMatchObject({ daysAhead: 7, courseId: 42 });
    expect(ctx).toMatchObject({
      mode: 'worker',
      source: 'Console',
      scopes: ['moodle:read', 'moodle:write'],
      publicUrl: ORIGIN,
      user: { moodleUserId: 1001 },
    });

    expect((await call('/api/due?days=abc', { cookie })).status).toBe(400);
    expect((await call('/api/due?days=500', { cookie })).status).toBe(400);
    expect((await call('/api/due')).status).toBe(401);
  });

  it('GET /api/courses lists with hidden courses included', async () => {
    const { cookie } = await connect();
    vi.mocked(listCourses).mockResolvedValue([]);
    expect((await call('/api/courses?classification=all', { cookie })).status).toBe(200);
    expect(vi.mocked(listCourses).mock.calls[0]?.[1]).toEqual({ classification: 'all', includeHidden: true });
    expect((await call('/api/courses', { cookie })).status).toBe(200);
    expect(vi.mocked(listCourses).mock.calls[1]?.[1]).toEqual({ classification: 'inprogress', includeHidden: true });
    expect((await call('/api/courses?classification=weird', { cookie })).status).toBe(400);
  });

  it('maps service errors to HTTP statuses', async () => {
    const { cookie } = await connect();
    vi.mocked(getDueItems).mockRejectedValue(new NeedsReconnect());
    const res = await call('/api/due', { cookie });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Body).error.code).toBe('needs_reconnect');

    vi.mocked(getDueItems).mockRejectedValue(new Error('boom'));
    const boom = await call('/api/due', { cookie });
    expect(boom.status).toBe(500);
    expect(((await boom.json()) as Body).error.code).toBe('internal');
  });
});

describe('API keys', () => {
  it('creates, lists and revokes keys; the secret is shown once and only its hash is stored', async () => {
    const { cookie, body } = await connect();
    const res = await post('/api/keys', { name: '  laptop  ', scopes: ['moodle:write'] }, cookie);
    expect(res.status).toBe(200);
    const created = (await res.json()) as Body;
    expect(created.secret).toMatch(/^wmm_[0-9A-Za-z]{40}$/);
    expect(created.key).toMatchObject({
      name: 'laptop',
      scopes: ['moodle:read', 'moodle:write'],
      revokedAt: null,
      lastUsedAt: null,
    });
    expect(created.key.prefix).toBe(created.secret.slice(0, 8));
    expect(created.key.createdAt).toMatch(/\+09:00$/);
    expect(JSON.stringify(created.key)).not.toContain(created.secret);

    const list = (await (await call('/api/keys', { cookie })).json()) as Row[];
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(
      ['createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt', 'scopes'].sort(),
    );

    const store = createD1Store(env.DB);
    expect(await resolveApiKey(store, created.secret)).toMatchObject({
      userId: body.user.id,
      source: 'API key: laptop',
    });

    expect((await call(`/api/keys/${created.key.id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect(await resolveApiKey(store, created.secret)).toBeNull();
    expect((await call(`/api/keys/${created.key.id}`, { method: 'DELETE', cookie })).status).toBe(404);
    const after = (await (await call('/api/keys', { cookie })).json()) as Row[];
    expect(after[0]?.revokedAt).toMatch(/\+09:00$/);
  });

  it('defaults to read-only and validates input', async () => {
    const { cookie } = await connect();
    const ro = (await (await post('/api/keys', { name: 'ci' }, cookie)).json()) as Body;
    expect(ro.key.scopes).toEqual(['moodle:read']);
    expect((await post('/api/keys', { name: '' }, cookie)).status).toBe(400);
    expect((await post('/api/keys', { name: 'x', scopes: ['admin'] }, cookie)).status).toBe(400);
    expect((await post('/api/keys', { name: 'x', scopes: [] }, cookie)).status).toBe(400);
    expect((await post('/api/keys', { name: 'x' })).status).toBe(401);
  });

  it('caps the number of active keys', async () => {
    const { cookie } = await connect();
    for (let i = 0; i < 20; i++) expect((await post('/api/keys', { name: `k${i}` }, cookie)).status).toBe(200);
    expect((await post('/api/keys', { name: 'one-too-many' }, cookie)).status).toBe(400);
  });
});

describe('OAuth apps', () => {
  it('lists grants with the client name from grant metadata and revokes them', async () => {
    const { cookie, body } = await connect();
    const uid = String(body.user.id);
    fp.grants.push(
      {
        id: 'g1',
        clientId: 'client-1',
        userId: uid,
        scope: ['moodle:read', 'junk'],
        metadata: { clientName: 'Claude' },
        createdAt: 1_700_000_000,
      },
      {
        id: 'g2',
        clientId: 'client-2',
        userId: uid,
        scope: ['moodle:read', 'moodle:write'],
        metadata: null,
        createdAt: 1_700_000_100,
      },
    );
    const apps = (await (await call('/api/apps', { cookie })).json()) as Row[];
    expect(apps).toEqual([
      {
        id: 'g1',
        clientId: 'client-1',
        clientName: 'Claude',
        scopes: ['moodle:read'],
        createdAt: '2023-11-15T07:13:20+09:00',
      },
      {
        id: 'g2',
        clientId: 'client-2',
        clientName: 'client-2',
        scopes: ['moodle:read', 'moodle:write'],
        createdAt: '2023-11-15T07:15:00+09:00',
      },
    ]);

    expect((await call('/api/apps/g1', { method: 'DELETE', cookie })).status).toBe(200);
    expect(fp.provider.revokeGrant).toHaveBeenCalledWith('g1', uid);
    expect((await (await call('/api/apps', { cookie })).json()) as Row[]).toHaveLength(1);
    expect((await call('/api/apps')).status).toBe(401);
  });
});

describe('write actions', () => {
  it('lists, approves (via console) and cancels', async () => {
    const { cookie } = await connect();
    vi.mocked(listActionRecords).mockResolvedValue([]);
    vi.mocked(confirmAction).mockResolvedValue({ actionId: 'act_1', status: 'executed', message: 'ok', url: null });
    vi.mocked(cancelAction).mockResolvedValue({
      actionId: 'act_1',
      status: 'cancelled',
      message: 'cancelled',
      url: null,
    });

    expect((await call('/api/actions?status=pending&limit=5', { cookie })).status).toBe(200);
    expect(vi.mocked(listActionRecords).mock.calls[0]?.[1]).toEqual({ status: 'pending', limit: 5 });
    expect((await call('/api/actions?status=weird', { cookie })).status).toBe(400);

    const approve = await call('/api/actions/act_1/approve', { method: 'POST', cookie });
    expect(((await approve.json()) as Body).status).toBe('executed');
    const [ctx, id, via] = vi.mocked(confirmAction).mock.calls[0] ?? [];
    expect(id).toBe('act_1');
    expect(via).toBe('console');
    expect(ctx).toMatchObject({ source: 'Console' });

    const cancel = await call('/api/actions/act_1/cancel', { method: 'POST', cookie });
    expect(((await cancel.json()) as Body).status).toBe('cancelled');
    expect((await call('/api/actions/act_1/approve', { method: 'POST' })).status).toBe(401);
  });
});

describe('activity', () => {
  it('returns the audit trail newest first with ids and JST timestamps', async () => {
    const { cookie, body } = await connect();
    const store = createD1Store(env.DB);
    await store.audit({
      userId: body.user.id,
      at: Date.UTC(2099, 0, 1, 3, 0, 0),
      actor: 'mcp:Claude',
      action: 'tool:get_due_items',
      detail: { n: 2 },
    });
    const rows = (await (await call('/api/activity?limit=10', { cookie })).json()) as Row[];
    expect(rows[0]).toEqual({
      id: expect.any(Number),
      at: '2099-01-01T12:00:00+09:00',
      actor: 'mcp:Claude',
      action: 'tool:get_due_items',
      detail: '{"n":2}',
    });
    expect(rows.some((r) => r.action === 'connect')).toBe(true);
  });

  it('pages with the numeric id of the last row as cursor', async () => {
    const { cookie, body } = await connect();
    const store = createD1Store(env.DB);
    for (const action of ['one', 'two', 'three']) {
      await store.audit({ userId: body.user.id, at: Date.now(), actor: 'console', action, detail: null });
    }
    const first = (await (await call('/api/activity?limit=2', { cookie })).json()) as Row[];
    expect(first.map((r) => r.action)).toEqual(['three', 'two']);
    const next = (await (await call(`/api/activity?limit=2&before=${first[1]?.id}`, { cookie })).json()) as Row[];
    expect(next.map((r) => r.action)).toEqual(['one', 'connect']);
    expect((await call('/api/activity?before=abc', { cookie })).status).toBe(400);
  });
});

describe('OAuth consent glue', () => {
  async function startAuthorize(): Promise<string> {
    const res = await call('/authorize?response_type=code&client_id=client-1');
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location') ?? '';
    expect(loc.startsWith(`${ORIGIN}/oauth/consent?req=`)).toBe(true);
    return decodeURIComponent(loc.split('req=')[1] ?? '');
  }

  it('/authorize stores the request for 10 minutes and redirects to the SPA', async () => {
    const id = await startAuthorize();
    expect(id).toMatch(/^req_/);
    const rec = (await kv.get(`oauthreq:${id}`, 'json')) as Body;
    expect(rec).toMatchObject({
      clientName: 'Claude',
      redirectHost: 'client.example.org',
      scopes: ['moodle:read', 'moodle:write'],
    });
    expect(rec.authRequest.clientId).toBe('client-1');
    expect(kv.data.get(`oauthreq:${id}`)?.expiresAt).not.toBeNull();
  });

  it('/authorize reports invalid requests', async () => {
    fp.state.parseError = Object.assign(new Error('bad'), {
      redirectTo: 'https://client.example.org/cb?error=invalid_scope',
    });
    const redirect = await call('/authorize');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('Location')).toBe('https://client.example.org/cb?error=invalid_scope');

    fp.state.parseError = new Error('unknown client');
    const local = await call('/authorize');
    expect(local.status).toBe(400);
    expect(((await local.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('shows request info only to signed-in users', async () => {
    const id = await startAuthorize();
    expect((await call(`/api/oauth/requests/${id}`)).status).toBe(401);
    const { cookie } = await connect();
    const info = (await (await call(`/api/oauth/requests/${id}`, { cookie })).json()) as Body;
    expect(info).toEqual({
      clientName: 'Claude',
      clientUri: 'https://claude.example.org',
      redirectHost: 'client.example.org',
      scopes: ['moodle:read', 'moodle:write'],
    });
    expect((await call('/api/oauth/requests/req_missing', { cookie })).status).toBe(404);
  });

  it('approve intersects scopes, completes the authorization once', async () => {
    const id = await startAuthorize();
    const { cookie, body } = await connect();

    expect((await post(`/api/oauth/requests/${id}/approve`, { scopes: [] }, cookie)).status).toBe(400);
    expect(fp.completed).toHaveLength(0);

    const res = await post(`/api/oauth/requests/${id}/approve`, { scopes: ['moodle:read'] }, cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).redirectTo).toContain('code=abc');
    expect(fp.completed).toHaveLength(1);
    expect(fp.completed[0]).toMatchObject({
      userId: String(body.user.id),
      scope: ['moodle:read'],
      metadata: { clientName: 'Claude' },
      props: { userId: body.user.id, scopes: ['moodle:read'], source: 'Claude' },
    });
    expect(fp.completed[0]?.request).toMatchObject({ clientId: 'client-1' });

    // single use
    expect((await post(`/api/oauth/requests/${id}/approve`, { scopes: ['moodle:read'] }, cookie)).status).toBe(404);
  });

  it('approve without a scopes list grants what was requested; write needs read', async () => {
    const id = await startAuthorize();
    const { cookie } = await connect();
    await post(`/api/oauth/requests/${id}/approve`, {}, cookie);
    expect(fp.completed[0]).toMatchObject({ scope: ['moodle:read', 'moodle:write'] });

    const id2 = await startAuthorize();
    await post(`/api/oauth/requests/${id2}/approve`, { scopes: ['moodle:write'] }, cookie);
    expect(fp.completed[1]).toMatchObject({ scope: ['moodle:read', 'moodle:write'] });
  });

  it('deny redirects with access_denied and consumes the request', async () => {
    const id = await startAuthorize();
    const { cookie } = await connect();
    const res = await post(`/api/oauth/requests/${id}/deny`, {}, cookie);
    const { redirectTo } = (await res.json()) as Body;
    const u = new URL(redirectTo);
    expect(u.origin + u.pathname).toBe('https://client.example.org/cb');
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('state')).toBe('st-1');
    expect(u.searchParams.get('iss')).toBe(ORIGIN);
    expect(await kv.get(`oauthreq:${id}`)).toBeNull();
    expect(fp.completed).toHaveLength(0);
  });
});

describe('file ticket routes', () => {
  it('streams downloads through with CORS and no cookies required', async () => {
    vi.mocked(streamDownload).mockImplementation(
      async () => new Response('file-bytes', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    const res = await call('/f/ticket-1');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('file-bytes');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    const [fileEnv, ticket] = vi.mocked(streamDownload).mock.calls[0] ?? [];
    expect(ticket).toBe('ticket-1');
    expect(typeof fileEnv?.makeMoodle).toBe('function');
    expect(fileEnv?.store).toBeDefined();
    expect(fileEnv?.signer).toBeDefined();
  });

  it('forwards uploads (PUT and POST) and answers preflight', async () => {
    vi.mocked(streamUpload).mockImplementation(async () => Response.json({ ok: true }, { status: 200 }));
    for (const method of ['PUT', 'POST']) {
      const res = await call('/u/tk?name=a.pdf', {
        method,
        body: 'xyz',
        mutating: false,
        headers: { 'Content-Type': 'application/pdf' },
      });
      expect(res.status, method).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
    expect(vi.mocked(streamUpload).mock.calls[0]?.[1]).toBe('tk');

    const pre = await call('/u/tk', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect((await call('/f/tk', { method: 'OPTIONS' })).status).toBe(204);
  });

  it('turns thrown errors into JSON with CORS', async () => {
    vi.mocked(streamDownload).mockRejectedValue(new Error('kaput'));
    const res = await call('/f/x');
    expect(res.status).toBe(500);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(((await res.json()) as Body).error.code).toBe('internal');
  });
});

describe('sanity', () => {
  it('cookie value is never stored raw', async () => {
    const { cookie } = await connect();
    const value = cookie.slice(SESSION_COOKIE.length + 1);
    const hash = await sha256Hex(value);
    const store = createD1Store(env.DB);
    expect(await store.getSession(hash)).not.toBeNull();
    expect(await store.getSession(value)).toBeNull();
  });
});
