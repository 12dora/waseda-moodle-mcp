import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/core/crypto';
import { NeedsReconnect } from '../../src/core/errors';
import { sweepForCron } from '../../src/core/services/sweep';
import { resetRateLimitMemory } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import worker, {
  buildProviderOptions,
  isPurgeRun,
  PURGE_CURSOR_KEY,
  providerFor,
  runScheduled,
} from '../../src/worker/index';
import { mcpApiHandler } from '../../src/worker/mcp';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

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
vi.mock('../../src/core/services/sweep', () => ({ sweepForCron: vi.fn() }));
vi.mock('../../src/core/services/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/services/scope')>()),
  resolveScope: vi.fn(async () => ({ mode: 'auto', mine: new Set(), courses: [] })),
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
  deferred = [];
  rec.purge.mockReset();
  vi.mocked(sweepForCron).mockReset().mockResolvedValue({ checked: 0, stale: 0, checkedAt: null });
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
    expect(rec.purge).toHaveBeenLastCalledWith(env, { batchSize: 25, cursor: undefined });
    expect(await kv.get(PURGE_CURSOR_KEY)).toBe('c1');
    expect(await store.listAudit(userId, { limit: 10 })).toEqual([]);

    await runScheduled(env, PURGE_TIME);
    expect(rec.purge).toHaveBeenLastCalledWith(env, { batchSize: 25, cursor: 'c1' });
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
    expect(sweepForCron).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sweepForCron).mock.calls[0]?.[1]).toEqual({ maxRefresh: 2 });

    rec.purge.mockRejectedValue(new Error('kv down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runScheduled(env, PURGE_TIME, execCtx());
    expect(sweepForCron).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('keeps going when one user needs to reconnect', async () => {
    await seedCredential();
    const second = await store.upsertUser({ moodleUserId: 1002, fullname: 'Hanako Sato', lang: 'ja' });
    await seedCredential(second.id, 'h2');
    vi.mocked(sweepForCron).mockRejectedValueOnce(new NeedsReconnect());
    await runScheduled(env, HOURLY_TIME);
    expect(sweepForCron).toHaveBeenCalledTimes(2);
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
