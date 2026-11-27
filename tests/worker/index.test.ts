import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvocationBudget } from '../../src/core/budget';
import { sha256Hex } from '../../src/core/crypto';
import { NeedsReconnect } from '../../src/core/errors';
import { refreshSnapshots } from '../../src/core/services/sweep/refresh';
import { resetRateLimitMemory } from '../../src/worker/auth';
import { getRuntime } from '../../src/worker/context';
import type { Env } from '../../src/worker/env';
import worker, { buildProviderOptions, isPurgeRun, providerFor, runScheduled } from '../../src/worker/index';
import { mcpApiHandler } from '../../src/worker/mcp';
import { meterD1 } from '../../src/worker/metered-d1';
import { resetSiteFlagMemory } from '../../src/worker/site-flag';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { fakeMoodleSession, SESSKEY } from '../helpers/fake-moodle-session';
import { MemoryKV } from '../helpers/memory-kv';

/** Mirrors the private KV key in src/worker/index.ts (workerd rejects non-handler exports from the entry). */
const PURGE_CURSOR_KEY = 'purge-cursor';

// `cloudflare:workers` only exists inside workerd, so the provider is replaced by a recording fake.
const rec = vi.hoisted(() => ({
  instances: [] as unknown[],
  purge: vi.fn(),
}));

vi.mock('@cloudflare/workers-oauth-provider', () => ({
  default: class {
    fetch = vi.fn(async () => new Response('from-provider'));
    purgeExpiredData = rec.purge;
    constructor(readonly options: unknown) {
      rec.instances.push(this);
    }
  },
}));
vi.mock('../../src/core/mcp/server', () => ({ buildMcpServer: vi.fn() }));
vi.mock('../../src/core/services/sweep/refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/services/sweep/refresh')>()),
  refreshSnapshots: vi.fn(),
}));
vi.mock('../../src/core/services/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/services/scope')>()),
  resolveScope: vi.fn(async () => {
    const { course } = await import('../services/sweep/helpers');
    return { mode: 'auto', mine: new Set([1]), courses: [course(1)] };
  }),
}));

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 5)));
const SECRET = `wmm_${'Qw3rTy9uIo'.repeat(4)}`;

let env: Env;
let kv: MemoryKV;
let store: D1Store;
let userId: number;
let deferred: Promise<unknown>[];
let n = 0;

const execCtx = () => ({ waitUntil: (p: Promise<unknown>) => void deferred.push(p) }) as unknown as ExecutionContext;

beforeEach(async () => {
  resetRateLimitMemory();
  resetSiteFlagMemory();
  deferred = [];
  rec.purge.mockReset();
  vi.mocked(refreshSnapshots)
    .mockReset()
    .mockResolvedValue({
      snapshots: new Map(),
      stats: { checked: 0, stale: 0, checkedAt: null },
      refreshed: 0,
      large: 0,
    });
  const { db } = createTestD1();
  kv = new MemoryKV();
  // unique URL per test: the Worker caches one provider per PUBLIC_URL
  env = {
    DB: db,
    OAUTH_KV: kv.asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: `https://t${++n}.example.com/`,
  } as Env;
  store = createD1Store(db);
  userId = (await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' })).id;
});

/** A token-only credential: usable (and swept) only while the mobile service is on (tests set it in the fake). */
async function seedCredential(id = userId, tokenHash = 'h1'): Promise<void> {
  await store.putCredential({
    userId: id,
    tokenEnc: 'enc',
    privateTokenEnc: null,
    tokenHash,
    tokenHint: 'tttt',
    status: 'active',
    connectedVia: 'paste',
    connectedAt: 1,
    lastOkAt: null,
    lastError: null,
  });
}

describe('provider options (contract §10)', () => {
  it('configures routes, scopes, TTLs and metadata', () => {
    const o = buildProviderOptions(env);
    const base = env.PUBLIC_URL.replace(/\/$/, '');
    expect(o).toMatchObject({
      apiRoute: '/mcp',
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: ['moodle:read', 'moodle:write'],
      requiredScopes: ['moodle:read', 'moodle:write'],
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 43200,
      refreshTokenTTL: 7776000,
      resourceMetadata: {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        resource_name: 'Waseda Moodle MCP',
      },
    });
    expect(o.apiHandler).toBe(mcpApiHandler);
    expect(typeof (o.apiHandler as { fetch: unknown }).fetch).toBe('function'); // object form, not a bare function
    expect(typeof (o.defaultHandler as { fetch: unknown }).fetch).toBe('function');
  });

  it('serves /health through the default handler (Hono app)', async () => {
    const res = await (
      buildProviderOptions(env).defaultHandler as { fetch: (...a: unknown[]) => Promise<Response> }
    ).fetch(new Request('https://x.test/health'), env, execCtx());
    expect(await res.json()).toEqual({ ok: true });
  });

  it('builds one provider per PUBLIC_URL and the default export delegates to it', async () => {
    const before = rec.instances.length;
    const res = await worker.fetch(new Request('https://x.test/anything'), env, execCtx());
    await worker.fetch(new Request('https://x.test/other'), env, execCtx());
    expect(await res.text()).toBe('from-provider');
    expect(rec.instances.length).toBe(before + 1);
    expect(providerFor(env)).toBe(rec.instances[rec.instances.length - 1]);
  });
});

describe('public endpoint throttling', () => {
  const hit = (path: string, method: string, ip: string) =>
    worker.fetch(new Request(`https://x.test${path}`, { method, headers: { 'CF-Connecting-IP': ip } }), env, execCtx());

  it('limits GET /authorize to 60 per 10 minutes per IP before the provider runs', async () => {
    const before = vi.mocked(providerFor(env).fetch).mock.calls.length;
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await hit('/authorize', 'GET', '203.0.113.9')).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
    expect(vi.mocked(providerFor(env).fetch).mock.calls.length - before).toBe(60);
    const limited = await hit('/authorize', 'GET', '203.0.113.9');
    expect(limited.headers.get('Retry-After')).toBe('600');
    expect(((await limited.json()) as { error: string }).error).toBe('temporarily_unavailable');
    expect((await hit('/authorize', 'GET', '203.0.113.10')).status).toBe(200); // other IPs unaffected
  });

  it('limits POST /register to 20 per hour per IP and ignores other methods and paths', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await hit('/register', 'POST', '203.0.113.20')).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    expect((await hit('/register', 'OPTIONS', '203.0.113.20')).status).toBe(200);
    expect((await hit('/mcp', 'GET', '203.0.113.20')).status).toBe(200);
  });

  it('uses D1 only (KV is reserved for the OAuth library) and fails open when D1 breaks', async () => {
    await hit('/authorize', 'GET', '203.0.113.30');
    expect(kv.ops.put).toBe(0);
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('D1 down');
        },
      },
    } as unknown as Env;
    for (let i = 0; i < 70; i++) {
      const res = await worker.fetch(
        new Request('https://x.test/authorize', { headers: { 'CF-Connecting-IP': '203.0.113.31' } }),
        broken,
        execCtx(),
      );
      expect(res.status).toBe(200);
    }
  });
});

describe('resolveExternalToken (API keys)', () => {
  const resolve = (token: string, request = new Request('https://x.test/mcp')) =>
    buildProviderOptions(env).resolveExternalToken({ token, request, env });

  beforeEach(async () => {
    await store.createApiKey({
      id: 'key_1',
      userId,
      name: 'laptop',
      prefix: SECRET.slice(0, 8),
      keyHash: await sha256Hex(SECRET),
      scopes: ['moodle:read'],
      createdAt: 1,
      lastUsedAt: null,
      revokedAt: null,
    });
  });

  it('accepts a valid key and binds it to the /mcp resource', async () => {
    const base = env.PUBLIC_URL.replace(/\/$/, '');
    expect(await resolve(SECRET)).toEqual({
      props: { userId, scopes: ['moodle:read'], source: 'API key: laptop' },
      audience: `${base}/mcp`,
    });
  });

  it('rejects anything that is not a live wmm_ key', async () => {
    expect(await resolve('someone:else:token')).toBeNull();
    expect(await resolve(`wmm_${'0'.repeat(40)}`)).toBeNull();
    await store.revokeApiKey(userId, 'key_1', 5);
    expect(await resolve(SECRET)).toBeNull();
  });

  it('defers the last-used write to the request execution context when one is known', async () => {
    const request = new Request('https://x.test/mcp');
    await worker.fetch(request, env, execCtx()); // registers request -> ctx
    deferred.length = 0;
    await resolve(SECRET, request);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect((await store.getApiKeyByHash(await sha256Hex(SECRET)))?.lastUsedAt).not.toBeNull();
  });
});

describe('scheduled', () => {
  const PURGE_TIME = Date.UTC(2026, 9, 15, 3, 17); // 03:17 UTC = 12:17 JST
  const HOURLY_TIME = Date.UTC(2026, 9, 15, 4, 17);
  const controller = (scheduledTime: number) => ({ scheduledTime }) as ScheduledController;
  let moodle: ReturnType<typeof fakeMoodleSession>;
  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;

  // every run asks Moodle whether its mobile web service is on
  beforeEach(() => {
    moodle = fakeMoodleSession({ mobileService: true });
    fetchSpy = vi.fn(moodle.fetch);
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Gives a stored credential a live web session. */
  async function addSession(id: number, cookie: string): Promise<void> {
    const { key } = await getRuntime(env);
    moodle.state.live.add(cookie);
    await store.updateCredentialStatus(id, {
      sessionEnc: await key.encrypt(cookie),
      sesskeyEnc: await key.encrypt(SESSKEY),
      sessionOkAt: 1,
    });
  }

  it('recognises only the 03:17 UTC run as the daily purge slot', () => {
    expect(isPurgeRun(PURGE_TIME)).toBe(true);
    expect(isPurgeRun(HOURLY_TIME)).toBe(false);
    expect(isPurgeRun(Date.UTC(2026, 9, 15, 3, 16))).toBe(false);
    expect(isPurgeRun(Date.UTC(2026, 9, 16, 3, 17))).toBe(true); // any day
  });

  it('runs D1 retention and persists the OAuth purge cursor between purge runs', async () => {
    await store.audit({ userId, at: 1, actor: 'x', action: 'ancient', detail: null });
    rec.purge.mockResolvedValueOnce({ done: false, cursor: 'c1' }).mockResolvedValueOnce({ done: true });

    worker.scheduled(controller(PURGE_TIME), env, execCtx());
    await Promise.all(deferred);
    // The purge runs on the invocation's metered D1, with the rest of the env unchanged.
    const meteredEnv = { ...env, DB: expect.objectContaining({ prepare: expect.any(Function) }) };
    expect(rec.purge).toHaveBeenLastCalledWith(meteredEnv, { batchSize: 25, cursor: undefined });
    expect(rec.purge.mock.lastCall?.[0].DB).not.toBe(env.DB);
    expect(await kv.get(PURGE_CURSOR_KEY)).toBe('c1');
    expect(await store.listAudit(userId, { limit: 10 })).toEqual([]);

    await runScheduled(env, PURGE_TIME);
    expect(rec.purge).toHaveBeenLastCalledWith(meteredEnv, { batchSize: 25, cursor: 'c1' });
    expect(await kv.get(PURGE_CURSOR_KEY)).toBeNull();
  });

  it('does not purge on the other hourly runs', async () => {
    await store.audit({ userId, at: 1, actor: 'x', action: 'ancient', detail: null });
    await runScheduled(env, HOURLY_TIME);
    expect(rec.purge).not.toHaveBeenCalled();
    expect(await store.listAudit(userId, { limit: 10 })).toHaveLength(1);
  });

  it('sweeps on every run, with a purge failure not blocking the sweep', async () => {
    await seedCredential();
    await runScheduled(env, HOURLY_TIME, execCtx());
    expect(refreshSnapshots).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refreshSnapshots).mock.calls[0]?.[2]).toMatchObject({ maxFull: 2, maxLarge: 1 });

    rec.purge.mockRejectedValue(new Error('kv down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runScheduled(env, PURGE_TIME, execCtx());
    expect(refreshSnapshots).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('is scheduled every hour of the day', () => {
    const wrangler = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
    expect(wrangler).toContain('"crons": ["17 * * * *"]');
  });

  it('runs only the session keepalive on the night runs, 15:17 to 21:17 UTC (00–06 JST)', async () => {
    moodle.state.mobileService = false; // the keepalive touches (with the service on it would go through launch.php)
    await seedCredential();
    await addSession(userId, 'MoodleSession=n1');
    for (const hour of [15, 18, 21]) await runScheduled(env, Date.UTC(2026, 9, 15, hour, 17), execCtx());
    expect(refreshSnapshots).not.toHaveBeenCalled();
    const touches = moodle.requests.filter((r) => r.path === '/lib/ajax/service.php');
    expect(touches).toHaveLength(1); // then confirmed recently
    expect((await store.getCredential(userId))?.sessionOkAt).toBeGreaterThan(1);
    for (const hour of [22, 14]) await runScheduled(env, Date.UTC(2026, 9, 15, hour, 17), execCtx());
    expect(refreshSnapshots).toHaveBeenCalledTimes(2);
  });

  it('keeps purge + keepalive + sweep within the per-invocation D1 query and subrequest limits', async () => {
    for (let i = 0; i < 25; i++) {
      const u = await store.upsertUser({ moodleUserId: 5000 + i, fullname: `User ${i}`, lang: 'en' });
      await seedCredential(u.id, `h${i}`);
      await addSession(u.id, `MoodleSession=p${i}`);
    }
    rec.purge.mockResolvedValue({ done: true });
    const counter = new InvocationBudget(10_000, 10_000); // only counts what the run really sends to D1
    await runScheduled({ ...env, DB: meterD1(env.DB, counter) }, PURGE_TIME, execCtx());
    await Promise.all(deferred);
    expect(10_000 - counter.queries).toBeLessThanOrEqual(50);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(50);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1); // the keepalive visited sessions
    expect(refreshSnapshots).toHaveBeenCalled(); // and the sweep still had room
  });

  it('keeps going when one user needs to reconnect', async () => {
    await seedCredential();
    const second = await store.upsertUser({ moodleUserId: 1002, fullname: 'Hanako Sato', lang: 'ja' });
    await seedCredential(second.id, 'h2');
    vi.mocked(refreshSnapshots).mockRejectedValueOnce(new NeedsReconnect());
    await runScheduled(env, HOURLY_TIME);
    expect(refreshSnapshots).toHaveBeenCalledTimes(2);
  });

  it('does not touch KV when there is nothing to remember', async () => {
    rec.purge.mockResolvedValue({ done: true });
    await runScheduled(env, PURGE_TIME);
    expect(kv.ops.put).toBe(0);
    expect(kv.ops.delete).toBe(0);
  });

  it('survives failures in either half', async () => {
    rec.purge.mockRejectedValue(new Error('kv down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(runScheduled(env, PURGE_TIME)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
