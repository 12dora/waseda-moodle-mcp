import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NeedsReconnect, NotFound } from '../../src/core/errors';
import {
  buildServiceContext,
  consoleProps,
  getRuntime,
  LAST_OK_INTERVAL_MS,
  makeMoodleFactory,
} from '../../src/worker/context';
import type { Env } from '../../src/worker/env';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

interface FakeClientOptions {
  token: string;
  moodleUserId: number;
  onTokenInvalid: () => Promise<void>;
  onSuccess: () => void;
  maxCalls?: number;
}

const created = vi.hoisted(() => [] as FakeClientOptions[]);

vi.mock('../../src/core/moodle/client', () => ({
  MoodleClient: class {
    constructor(readonly opts: FakeClientOptions) {
      created.push(opts);
    }
  },
}));

function firstClient(): FakeClientOptions {
  const client = created[0];
  if (!client) throw new Error('no Moodle client was created');
  return client;
}

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 11)));

let env: Env;
let store: D1Store;
let userId: number;
let deferred: Promise<unknown>[];
const execCtx = () => ({ waitUntil: (p: Promise<unknown>) => void deferred.push(p) }) as unknown as ExecutionContext;

async function storeCredential(over: { status?: 'active' | 'invalid'; lastOkAt?: number | null } = {}) {
  const rt = await getRuntime(env);
  await store.putCredential({
    userId,
    tokenEnc: await rt.key.encrypt('t'.repeat(32)),
    privateTokenEnc: null,
    tokenHash: 'h',
    tokenHint: 'tttt',
    status: over.status ?? 'active',
    connectedVia: 'paste',
    connectedAt: 1,
    lastOkAt: over.lastOkAt ?? null,
    lastError: null,
  });
}

beforeEach(async () => {
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

  it('needs a stored, active credential', async () => {
    await expect((await build()).moodle()).rejects.toBeInstanceOf(NeedsReconnect);
    await storeCredential({ status: 'invalid' });
    await expect((await build()).moodle()).rejects.toBeInstanceOf(NeedsReconnect);
    expect(created).toHaveLength(0);
  });

  it('decrypts the token, passes the Moodle user id and shares one client per request', async () => {
    await storeCredential();
    const ctx = await build();
    const a = await ctx.moodle();
    const b = await ctx.moodle();
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ token: 't'.repeat(32), moodleUserId: 1001 });
  });

  it('caps the client budget when asked to', async () => {
    await storeCredential();
    const props = { userId, scopes: ['moodle:read' as const], source: 'Scheduled sweep' };
    await (await buildServiceContext(env, execCtx(), props, { maxCalls: 12 })).moodle();
    expect(created[0]).toMatchObject({ maxCalls: 12 });
    created.length = 0;
    await (await buildServiceContext(env, execCtx(), props)).moodle();
    expect(created[0]?.maxCalls).toBeUndefined(); // the client's own default applies
  });

  it('marks the credential invalid when Moodle rejects the token', async () => {
    await storeCredential();
    await (await build()).moodle();
    await firstClient().onTokenInvalid();
    expect(await store.getCredential(userId)).toMatchObject({ status: 'invalid' });
    expect((await store.getCredential(userId))?.lastError).toBeTruthy();
  });

  it('refreshes lastOkAt lazily, at most every 10 minutes', async () => {
    await storeCredential({ lastOkAt: Date.now() - 2 * LAST_OK_INTERVAL_MS });
    await (await build()).moodle();
    deferred.length = 0;
    firstClient().onSuccess();
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    const cred = await store.getCredential(userId);
    expect(Date.now() - (cred?.lastOkAt ?? 0)).toBeLessThan(5000);

    created.length = 0;
    await (await build()).moodle(); // lastOkAt is fresh now
    deferred.length = 0;
    firstClient().onSuccess();
    expect(deferred).toHaveLength(0);
  });
});

describe('makeMoodleFactory', () => {
  it('builds clients by user id for the file routes', async () => {
    await storeCredential();
    const make = makeMoodleFactory(env, execCtx());
    await make(userId);
    expect(created[0]).toMatchObject({ moodleUserId: 1001 });
    await expect(make(4242)).rejects.toBeInstanceOf(NotFound);
  });
});
