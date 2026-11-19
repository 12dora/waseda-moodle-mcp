import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvocationBudget } from '../../src/core/budget';
import type { MailCredentialRow } from '../../src/core/context';
import { importMasterKey, type MasterKey } from '../../src/core/crypto';
import type { Env } from '../../src/worker/env';
import { runMailIdle } from '../../src/worker/mail-idle';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 11)));
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

let t: TestD1;
let env: Env;
let store: D1Store;
let key: MasterKey;
let revoked: string[];
let revokeStatus: number;
/** Runs inside the fake revoke call (simulates what happens meanwhile). */
let duringRevoke: (token: string) => Promise<void>;

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: t.db,
    OAUTH_KV: {} as KVNamespace,
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: 'https://wasemoodle.example.com',
    REGISTRATION: 'open',
    ALLOWED_MOODLE_USERIDS: '',
    OAUTH_PROVIDER: {} as Env['OAUTH_PROVIDER'],
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'secret',
    ...over,
  };
}

async function connected(
  moodleUserId: number,
  lastUsedAt: number | null,
  connectedAt = NOW - 200 * DAY,
  approved = true,
) {
  const user = await store.upsertUser({ moodleUserId, fullname: 'Taro Yamada', lang: 'ja' });
  if (approved) await store.decideMailAccess(user.id, { status: 'approved', by: 9001, at: 1, from: null });
  const row: MailCredentialRow = {
    userId: user.id,
    address: `u${moodleUserId}@akane.waseda.jp`,
    googleSub: `sub-${moodleUserId}`,
    refreshEnc: await key.encrypt(`rt-${moodleUserId}`),
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    status: 'active',
    connectedAt,
    lastUsedAt,
    lastError: null,
    idleTriedAt: null,
  };
  await store.putMailCredential(row);
  return user.id;
}

const usageRows = (): number => (t.sqlite.prepare('SELECT COUNT(*) AS n FROM usage_counts').get() as { n: number }).n;

beforeEach(async () => {
  t = createTestD1();
  env = makeEnv();
  store = createD1Store(t.db);
  key = await importMasterKey(MASTER_KEY);
  revoked = [];
  revokeStatus = 200;
  duringRevoke = async () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const token = new URLSearchParams(String(init?.body)).get('token') ?? '';
      revoked.push(token);
      await duringRevoke(token);
      return new Response('', { status: revokeStatus });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('runMailIdle', () => {
  it('revokes connections idle for MAIL_IDLE_DAYS and keeps the row with the reason', async () => {
    const idle = await connected(1001, NOW - 91 * DAY);
    const neverUsed = await connected(1002, null, NOW - 95 * DAY);
    const recent = await connected(1003, NOW - 10 * DAY);
    const before = usageRows();

    expect(await runMailIdle(env, new InvocationBudget(10, 20), NOW)).toBe(2);
    expect(revoked).toEqual(['rt-1002', 'rt-1001']);
    for (const id of [idle, neverUsed]) {
      expect(await store.getMailCredential(id)).toMatchObject({
        status: 'invalid',
        refreshEnc: null,
        lastError: 'Disconnected after 90 days without use.',
      });
    }
    expect((await store.getMailCredential(recent))?.status).toBe('active');
    expect(usageRows()).toBe(before);

    // nothing left to do on the next run
    expect(await runMailIdle(env, new InvocationBudget(10, 20), NOW)).toBe(0);
  });

  it('follows MAIL_IDLE_DAYS and does nothing when off or mail is not configured', async () => {
    const id = await connected(1001, NOW - 40 * DAY);
    expect(await runMailIdle(makeEnv({ MAIL_IDLE_DAYS: 'off' }), new InvocationBudget(10, 20), NOW)).toBe(0);
    expect(await runMailIdle(makeEnv({ GOOGLE_CLIENT_ID: '' }), new InvocationBudget(10, 20), NOW)).toBe(0);
    expect(revoked).toEqual([]);
    expect(await runMailIdle(makeEnv({ MAIL_IDLE_DAYS: '30' }), new InvocationBudget(10, 20), NOW)).toBe(1);
    expect((await store.getMailCredential(id))?.lastError).toBe('Disconnected after 30 days without use.');
  });

  it('stops when the shared budget runs out', async () => {
    await connected(1001, NOW - 100 * DAY);
    await connected(1002, NOW - 99 * DAY);
    const budget = new InvocationBudget(1, 20);
    expect(await runMailIdle(env, budget, NOW)).toBe(1);
    expect(revoked).toEqual(['rt-1001']);
    expect(budget.moodle).toBe(0);
  });

  it('does not start a row when only one D1 query remains (end + stamp may cost two)', async () => {
    await connected(1001, NOW - 100 * DAY);
    expect(await runMailIdle(env, new InvocationBudget(10, 1), NOW)).toBe(0);
    expect(revoked).toEqual([]);
  });

  it('keeps a connection Google could not be asked about for the next run, behind the others', async () => {
    const id = await connected(1001, NOW - 100 * DAY);
    revokeStatus = 503;
    expect(await runMailIdle(env, new InvocationBudget(10, 20), NOW)).toBe(0);
    expect(await store.getMailCredential(id)).toMatchObject({ status: 'active', idleTriedAt: NOW });

    // the failing row no longer blocks a newer idle one
    await connected(1002, NOW - 95 * DAY);
    revokeStatus = 200;
    revoked = [];
    expect(await runMailIdle(env, new InvocationBudget(1, 20), NOW + DAY)).toBe(1);
    expect(revoked).toEqual(['rt-1002']);
  });

  it('never touches a connection the user renewed while the run was revoking the old one', async () => {
    const id = await connected(1001, NOW - 100 * DAY);
    duringRevoke = async () => {
      const row = await store.getMailCredential(id);
      if (row) await store.putMailCredential({ ...row, refreshEnc: await key.encrypt('rt-fresh'), lastUsedAt: NOW });
    };
    expect(await runMailIdle(env, new InvocationBudget(10, 20), NOW)).toBe(0);
    const row = await store.getMailCredential(id);
    expect(row).toMatchObject({ status: 'active', lastError: null, idleTriedAt: null });
    expect(await key.decrypt(row?.refreshEnc ?? '')).toBe('rt-fresh');
  });

  it('survives a row it cannot decrypt', async () => {
    const broken = await connected(1001, NOW - 100 * DAY);
    await store.updateMailCredential(broken, { refreshEnc: 'not-encrypted' });
    const ok = await connected(1002, NOW - 99 * DAY);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runMailIdle(env, new InvocationBudget(10, 20), NOW)).toBe(1);
    expect((await store.getMailCredential(ok))?.status).toBe('invalid');
    expect((await store.getMailCredential(broken))?.idleTriedAt).toBe(NOW);
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0])).not.toContain('not-encrypted');
    spy.mockRestore();
  });
});

describe('runMailIdle: connections without approval', () => {
  const recent = NOW - DAY;

  it('disconnects owners neither approved nor operators, revokes their token and keeps the others', async () => {
    env = makeEnv({ ADMIN_MOODLE_USERIDS: '1009' });
    const noRow = await connected(1001, recent, NOW - 2 * DAY, false);
    const rejected = await connected(1002, recent, NOW - 2 * DAY, false);
    await store.decideMailAccess(rejected, { status: 'rejected', by: 9001, at: 5, from: null });
    const pending = await connected(1003, recent, NOW - 2 * DAY, false);
    await store.requestMailAccess(pending, 5);
    const approved = await connected(1004, recent, NOW - 2 * DAY);
    const operator = await connected(1009, recent, NOW - 2 * DAY, false);
    const before = usageRows();

    expect(await runMailIdle(env, new InvocationBudget(10, 20), NOW)).toBe(3);
    expect(revoked.sort()).toEqual(['rt-1001', 'rt-1002', 'rt-1003']);
    for (const id of [noRow, rejected, pending]) expect(await store.getMailCredential(id)).toBeNull();
    for (const id of [approved, operator]) expect((await store.getMailCredential(id))?.status).toBe('active');
    expect(usageRows()).toBe(before);
    expect(await runMailIdle(env, new InvocationBudget(10, 20), NOW)).toBe(0);
  });

  it('runs with MAIL_IDLE_DAYS off and deletes a connection without a token without asking Google', async () => {
    const id = await connected(1001, recent, NOW - 2 * DAY, false);
    await store.updateMailCredential(id, { status: 'invalid', refreshEnc: null });
    expect(await runMailIdle(makeEnv({ MAIL_IDLE_DAYS: 'off' }), new InvocationBudget(10, 20), NOW)).toBe(1);
    expect(revoked).toEqual([]);
    expect(await store.getMailCredential(id)).toBeNull();
  });

  it('keeps a connection whose revoke Google did not confirm, for the next run', async () => {
    const id = await connected(1001, recent, NOW - 2 * DAY, false);
    revokeStatus = 503;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runMailIdle(env, new InvocationBudget(10, 20), NOW)).toBe(0);
    expect(await store.getMailCredential(id)).not.toBeNull();
    warn.mockRestore();
  });

  it('stops when the shared budget runs out and leaves the idle cleanup nothing', async () => {
    await connected(1001, NOW - 100 * DAY, NOW - 200 * DAY, false);
    await connected(1002, NOW - 100 * DAY, NOW - 200 * DAY, false);
    const budget = new InvocationBudget(1, 20);
    expect(await runMailIdle(env, budget, NOW)).toBe(1);
    expect(revoked).toEqual(['rt-1001']);
    expect(budget.moodle).toBe(0);
  });

  it('fills its batch past the operators', async () => {
    const operators = Array.from({ length: 12 }, (_, i) => 2001 + i);
    env = makeEnv({ ADMIN_MOODLE_USERIDS: operators.join(',') });
    for (const m of operators) await connected(m, recent, NOW - 2 * DAY, false);
    const last = await connected(1001, recent, NOW - 2 * DAY, false);
    expect(await runMailIdle(env, new InvocationBudget(20, 50), NOW)).toBe(1);
    expect(await store.getMailCredential(last)).toBeNull();
  });
});
