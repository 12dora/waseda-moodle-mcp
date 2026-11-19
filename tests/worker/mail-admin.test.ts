import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRow } from '../../src/core/context';
import { importMasterKey } from '../../src/core/crypto';
import { createApi } from '../../src/worker/api';
import { resetRateLimitMemory, startSession } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';

const ORIGIN = 'https://wasemoodle.example.com';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 5)));
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const READ = 'https://www.googleapis.com/auth/gmail.readonly';

type Json = Record<string, unknown>;

const app = createApi();
let env: Env;
let store: D1Store;
let operator: UserRow;
let applicant: UserRow;
let operatorCookie: string;
let applicantCookie: string;
let pending: Promise<unknown>[];
let revoked: string[];
let sqlite: DatabaseSync;

function makeEnv(over: Partial<Env> = {}): Env {
  const d1 = createTestD1();
  sqlite = d1.sqlite;
  return {
    DB: d1.db,
    OAUTH_KV: {} as KVNamespace,
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: ORIGIN,
    REGISTRATION: 'open',
    ALLOWED_MOODLE_USERIDS: '',
    ADMIN_MOODLE_USERIDS: '1001',
    OAUTH_PROVIDER: {} as Env['OAUTH_PROVIDER'],
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'secret',
    MAIL_SLOTS: '5',
    ...over,
  };
}

async function sessionCookie(userId: number): Promise<string> {
  return (await startSession(store, userId, null)).setCookie.split(';')[0] ?? '';
}

async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Cookie', init.cookie ?? operatorCookie);
  if ((init.method ?? 'GET') !== 'GET') {
    headers.set('X-WMM', '1');
    headers.set('Origin', ORIGIN);
  }
  const execCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, execCtx);
  await Promise.all(pending.splice(0));
  return res;
}

const decide = (userId: number, decision: string, cookie?: string) =>
  call(`/api/admin/mail/requests/${userId}/${decision}`, { method: 'POST', cookie });

const setAccess = (userId: number, status: 'approved' | 'rejected', at: number) =>
  store.decideMailAccess(userId, { status, by: 1001, at, from: null });

const errorOf = async (res: Response): Promise<Json> => ((await res.json()) as { error: Json }).error;

async function connectApplicant(refreshToken: string): Promise<void> {
  const key = await importMasterKey(MASTER_KEY);
  await store.putMailCredential({
    userId: applicant.id,
    address: 'hanako@akane.waseda.jp',
    googleSub: 'sub-2',
    refreshEnc: await key.encrypt(refreshToken),
    scopes: [READ],
    status: 'active',
    connectedAt: 100,
    lastUsedAt: null,
    lastError: null,
    idleTriedAt: null,
  });
}

beforeEach(async () => {
  resetRateLimitMemory();
  pending = [];
  revoked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== REVOKE_URL) throw new Error(`unexpected fetch ${String(input)}`);
      revoked.push(new URLSearchParams(String(init?.body ?? '')).get('token') ?? '');
      return new Response('', { status: 200 });
    }),
  );
  env = makeEnv();
  store = createD1Store(env.DB);
  operator = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
  applicant = await store.upsertUser({ moodleUserId: 1002, fullname: 'Hanako Sato', lang: 'ja' });
  operatorCookie = await sessionCookie(operator.id);
  applicantCookie = await sessionCookie(applicant.id);
});

afterEach(() => vi.unstubAllGlobals());

describe('operator guard', () => {
  it('answers 404 to non-operators on every route', async () => {
    await store.requestMailAccess(applicant.id, 1);
    const list = await call('/api/admin/mail/requests', { cookie: applicantCookie });
    expect(list.status).toBe(404);
    expect(await errorOf(list)).toEqual({ code: 'not_found', message: 'Not found.' });
    for (const decision of ['approve', 'reject', 'revoke']) {
      expect((await decide(applicant.id, decision, applicantCookie)).status).toBe(404);
    }
    expect((await store.getMailAccess(applicant.id))?.status).toBe('pending');
  });

  it('needs a session and the CSRF header on POST', async () => {
    expect((await call('/api/admin/mail/requests', { cookie: '' })).status).toBe(401);
    await store.requestMailAccess(applicant.id, 1);
    const noCsrf = await app.fetch(
      new Request(`${ORIGIN}/api/admin/mail/requests/${applicant.id}/approve`, {
        method: 'POST',
        headers: { Cookie: operatorCookie },
      }),
      env,
    );
    expect(noCsrf.status).toBe(403);
    expect((await store.getMailAccess(applicant.id))?.status).toBe('pending');
  });
});

describe('GET /api/admin/mail/requests', () => {
  it('lists pending requests by default, filters by status and reports the slots', async () => {
    const third = await store.upsertUser({ moodleUserId: 1003, fullname: 'Jiro Suzuki', lang: 'en' });
    await store.requestMailAccess(applicant.id, 10);
    await store.requestMailAccess(third.id, 20);
    await setAccess(third.id, 'approved', 30);
    await store.takeMailSlot(1003, 30, null);

    const res = await call('/api/admin/mail/requests');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requests: [
        {
          userId: applicant.id,
          fullname: 'Hanako Sato',
          moodleUserId: 1002,
          status: 'pending',
          requestedAt: 10,
          decidedAt: null,
          connection: null,
        },
      ],
      slots: { used: 1, limit: 5 },
    });

    const approved = (await (await call('/api/admin/mail/requests?status=approved')).json()) as { requests: Json[] };
    expect(approved.requests.map((r) => r.userId)).toEqual([third.id]);
    const rejected = (await (await call('/api/admin/mail/requests?status=rejected')).json()) as { requests: Json[] };
    expect(rejected.requests).toEqual([]);
    expect((await call('/api/admin/mail/requests?status=all')).status).toBe(400);
  });

  it('leaves the operators out of the list', async () => {
    await store.requestMailAccess(operator.id, 5);
    await store.requestMailAccess(applicant.id, 10);
    const body = (await (await call('/api/admin/mail/requests')).json()) as { requests: Json[] };
    expect(body.requests.map((r) => r.userId)).toEqual([applicant.id]);
  });

  it('reports unlimited slots as null', async () => {
    env = makeEnv({ MAIL_SLOTS: 'off' });
    store = createD1Store(env.DB);
    operator = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
    operatorCookie = await sessionCookie(operator.id);
    const body = (await (await call('/api/admin/mail/requests')).json()) as { slots: Json };
    expect(body.slots).toEqual({ used: 0, limit: null });
  });
});

describe('POST /api/admin/mail/requests/:userId/:decision', () => {
  it('approves a pending request and audits it on the applicant', async () => {
    await store.requestMailAccess(applicant.id, 10);
    const res = await decide(applicant.id, 'approve');
    expect(await res.json()).toEqual({ status: 'approved' });
    expect(await store.getMailAccess(applicant.id)).toMatchObject({ status: 'approved', decidedBy: 1001 });
    const audit = await store.listAudit(applicant.id, { limit: 5 });
    expect(audit.map((a) => [a.actor, a.action, a.detail])).toContainEqual(['operator', 'mail:approved', {}]);
    expect(await store.listAudit(operator.id, { limit: 5 })).toEqual([]);
  });

  it('rejects a pending request', async () => {
    await store.requestMailAccess(applicant.id, 10);
    expect(await (await decide(applicant.id, 'reject')).json()).toEqual({ status: 'rejected' });
    expect((await store.getMailAccess(applicant.id))?.status).toBe('rejected');
    const audit = await store.listAudit(applicant.id, { limit: 5 });
    expect(audit.map((a) => a.action)).toContain('mail:rejected');
  });

  it('approve from pending or rejected; reject only from pending; revoke from approved', async () => {
    await store.requestMailAccess(applicant.id, 10);
    const notApproved = await decide(applicant.id, 'revoke');
    expect(notApproved.status).toBe(400);
    expect((await errorOf(notApproved)).message).toBe('Mail access is not approved.');

    await setAccess(applicant.id, 'approved', 20);
    const reapprove = await decide(applicant.id, 'approve');
    expect(reapprove.status).toBe(400);
    expect((await errorOf(reapprove)).message).toBe('The request is already approved.');
    const reject = await decide(applicant.id, 'reject');
    expect(reject.status).toBe(400);
    expect((await errorOf(reject)).message).toBe('The request is not pending.');
    await setAccess(applicant.id, 'rejected', 30);
    expect((await decide(applicant.id, 'reject')).status).toBe(400);
    expect((await decide(applicant.id, 'revoke')).status).toBe(400);
    expect((await store.getMailAccess(applicant.id))?.status).toBe('rejected');

    // a rejected application can be approved after all
    expect(await (await decide(applicant.id, 'approve')).json()).toEqual({ status: 'approved' });
    expect(await store.getMailAccess(applicant.id)).toMatchObject({ status: 'approved', decidedBy: 1001 });
  });

  it('a decision on a request that changed since it was read answers InvalidInput', async () => {
    await store.requestMailAccess(applicant.id, 10);
    // another operator approves between the state check and the write (the write is conditional on the state)
    const db = env.DB;
    const prepare = (sql: string) => {
      if (sql.startsWith('UPDATE mail_access')) {
        sqlite.prepare("UPDATE mail_access SET status = 'approved' WHERE user_id = ?").run(applicant.id);
      }
      return db.prepare(sql);
    };
    const DB = new Proxy(db, {
      get(target, k) {
        if (k === 'prepare') return prepare;
        const v: unknown = Reflect.get(target, k, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    env = { ...env, DB };
    const res = await decide(applicant.id, 'reject');
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('The request changed. Reload and try again.');
    expect((await store.getMailAccess(applicant.id))?.status).toBe('approved');
  });

  it('revoke ends a connection held without approval, creating the rejected row', async () => {
    await connectApplicant('rt-orphan');
    const res = await decide(applicant.id, 'revoke');
    expect(await res.json()).toEqual({ status: 'rejected' });
    expect(revoked).toEqual(['rt-orphan']);
    expect(await store.getMailCredential(applicant.id)).toBeNull();
    const row = await store.getMailAccess(applicant.id);
    expect(row).toMatchObject({ status: 'rejected', decidedBy: 1001 });
    expect(row?.requestedAt).toBe(row?.decidedAt);

    // pending with a connection: revoked too
    await store.requestMailAccess(applicant.id, 50);
    await connectApplicant('rt-pending');
    expect(await (await decide(applicant.id, 'revoke')).json()).toEqual({ status: 'rejected' });
    expect(await store.getMailCredential(applicant.id)).toBeNull();
    expect((await store.getMailAccess(applicant.id))?.requestedAt).toBe(50);
  });

  it('revoke writes the status before it disconnects (a racing callback then sees it gone)', async () => {
    await store.requestMailAccess(applicant.id, 10);
    await setAccess(applicant.id, 'approved', 20);
    await connectApplicant('rt-applicant');
    const seen: (string | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        seen.push((await store.getMailAccess(applicant.id))?.status);
        return new Response('', { status: 200 });
      }),
    );
    expect((await decide(applicant.id, 'revoke')).status).toBe(200);
    expect(seen).toEqual(['rejected']);
  });

  it('answers InvalidInput for an unknown user or one without an application; 404 for a bad path', async () => {
    const unknown = await decide(99999, 'approve');
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).message).toBe('Unknown user.');
    expect((await decide(applicant.id, 'approve')).status).toBe(400);
    expect((await decide(applicant.id, 'delete')).status).toBe(404);
    expect((await call('/api/admin/mail/requests/abc/approve', { method: 'POST' })).status).toBe(404);
  });

  it('revoke disconnects the mail, revokes the Google token and audits it', async () => {
    await store.requestMailAccess(applicant.id, 10);
    await setAccess(applicant.id, 'approved', 20);
    await connectApplicant('rt-applicant');

    const res = await decide(applicant.id, 'revoke');
    expect(await res.json()).toEqual({ status: 'rejected' });
    expect(revoked).toEqual(['rt-applicant']);
    expect(await store.getMailCredential(applicant.id)).toBeNull();
    expect(await store.getMailAccess(applicant.id)).toMatchObject({ status: 'rejected', decidedBy: 1001 });
    const audit = await store.listAudit(applicant.id, { limit: 5 });
    expect(audit.map((a) => [a.actor, a.action])).toContainEqual(['operator', 'mail:revoked']);

    // the applicant can no longer connect
    const connect = await call('/api/mail/connect', { method: 'POST', cookie: applicantCookie });
    expect(connect.status).toBe(403);
  });

  it('operators cannot be decided on', async () => {
    await store.requestMailAccess(operator.id, 10);
    await setAccess(operator.id, 'approved', 20);
    for (const decision of ['revoke', 'reject', 'approve']) {
      const res = await decide(operator.id, decision);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).message).toBe('Operators are always approved.');
    }
    expect((await store.getMailAccess(operator.id))?.status).toBe('approved');
  });
});
