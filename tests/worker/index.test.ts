import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/core/crypto';
import type { Env } from '../../src/worker/env';
import worker, { buildProviderOptions, PURGE_CURSOR_KEY, providerFor, runScheduled } from '../../src/worker/index';
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
  deferred = [];
  rec.purge.mockReset();
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
      requiredScopes: ['moodle:read'],
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
  it('runs D1 retention and persists the OAuth purge cursor between runs', async () => {
    await store.audit({ userId, at: 1, actor: 'x', action: 'ancient', detail: null });
    rec.purge.mockResolvedValueOnce({ done: false, cursor: 'c1' }).mockResolvedValueOnce({ done: true });

    worker.scheduled({} as ScheduledController, env, execCtx());
    await Promise.all(deferred);
    expect(rec.purge).toHaveBeenLastCalledWith(env, { batchSize: 25, cursor: undefined });
    expect(await kv.get(PURGE_CURSOR_KEY)).toBe('c1');
    expect(await store.listAudit(userId, { limit: 10 })).toEqual([]);

    await runScheduled(env);
    expect(rec.purge).toHaveBeenLastCalledWith(env, { batchSize: 25, cursor: 'c1' });
    expect(await kv.get(PURGE_CURSOR_KEY)).toBeNull();
  });

  it('does not touch KV when there is nothing to remember', async () => {
    rec.purge.mockResolvedValue({ done: true });
    await runScheduled(env);
    expect(kv.ops.put).toBe(0);
    expect(kv.ops.delete).toBe(0);
  });

  it('survives failures in either half', async () => {
    rec.purge.mockRejectedValue(new Error('kv down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(runScheduled(env)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
