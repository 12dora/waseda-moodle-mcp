import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailCredentialRow, UserRow } from '../../src/core/context';
import { b64urlEncode, importMasterKey, type MasterKey } from '../../src/core/crypto';
import { createApi } from '../../src/worker/api';
import { resetRateLimitMemory, startSession } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';

const ORIGIN = 'https://wasemoodle.example.com';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 3)));
const CLIENT_ID = 'cid.apps.googleusercontent.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const GML_COOKIE = '__Host-wmm_gml';

type Json = Record<string, unknown>;

const app = createApi();
let env: Env;
let store: D1Store;
let key: MasterKey;
let user: UserRow;
let cookie: string;
let pending: Promise<unknown>[];
let sqlite: DatabaseSync;

/** What the fake Google token endpoint answers, and what reached Google. */
let google: {
  token: (form: URLSearchParams) => Response;
  exchanges: URLSearchParams[];
  revoked: string[];
  /** The revoke endpoint cannot be reached. */
  revokeDown: boolean;
};

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
    OAUTH_PROVIDER: {} as Env['OAUTH_PROVIDER'],
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'secret',
    ...over,
  };
}

async function signIn(e: Env, moodleUserId = 1001): Promise<void> {
  env = e;
  store = createD1Store(env.DB);
  user = await store.upsertUser({ moodleUserId, fullname: 'Taro Yamada', lang: 'ja' });
  cookie = (await startSession(store, user.id, null)).setCookie.split(';')[0] ?? '';
}

async function call(path: string, init: RequestInit & { cookies?: string[] } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Cookie', (init.cookies ?? [cookie]).join('; '));
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

const idToken = (claims: Json): string =>
  ['{"alg":"RS256"}', JSON.stringify(claims), 'sig'].map((s) => b64urlEncode(new TextEncoder().encode(s))).join('.');

function tokenAnswer(nonce: string, over: { claims?: Json; body?: Json } = {}): Response {
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    nonce,
    sub: '110169484474386276334',
    email: 'Taro@akane.waseda.jp',
    email_verified: true,
    hd: 'akane.waseda.jp',
    ...over.claims,
  };
  return Response.json({
    access_token: 'at-new',
    refresh_token: 'rt-new',
    expires_in: 3599,
    scope: `openid https://www.googleapis.com/auth/userinfo.email ${READ} ${SEND}`,
    id_token: idToken(claims),
    ...over.body,
  });
}

interface Flow {
  url: URL;
  state: string;
  nonce: string;
  stateCookie: string;
}

async function startFlow(): Promise<Flow> {
  const res = await call('/api/mail/connect', { method: 'POST' });
  expect(res.status).toBe(200);
  const url = new URL(((await res.json()) as { url: string }).url);
  const state = url.searchParams.get('state') ?? '';
  const stateCookie = res.headers.get('Set-Cookie')?.split(';')[0] ?? '';
  return { url, state, nonce: url.searchParams.get('nonce') ?? '', stateCookie };
}

/** Runs the callback; answers the `mail=` result of the redirect. */
async function callback(flow: Flow, query: Json = { code: 'code-1' }, cookies?: string[]): Promise<string> {
  const qs = new URLSearchParams({ state: flow.state, ...(query as Record<string, string>) });
  const res = await call(`/api/google/callback?${qs}`, { cookies: cookies ?? [cookie, flow.stateCookie] });
  expect(res.status).toBe(302);
  expect(res.headers.get('Set-Cookie')).toContain(`${GML_COOKIE}=; Max-Age=0`);
  const location = new URL(res.headers.get('Location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(`${ORIGIN}/settings/mail`);
  return location.searchParams.get('mail') ?? '';
}

beforeEach(async () => {
  resetRateLimitMemory();
  pending = [];
  key = await importMasterKey(MASTER_KEY);
  google = { token: () => new Response('', { status: 500 }), exchanges: [], revoked: [], revokeDown: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (String(input) === REVOKE_URL) {
        if (google.revokeDown) throw new TypeError('network down');
        google.revoked.push(form.get('token') ?? '');
        return new Response('', { status: 200 });
      }
      if (String(input) === TOKEN_URL) {
        google.exchanges.push(form);
        return google.token(form);
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    }),
  );
  await signIn(makeEnv());
});

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/mail/connect', () => {
  it('is 404 when mail is not configured', async () => {
    await signIn(makeEnv({ GOOGLE_CLIENT_SECRET: '' }));
    const res = await call('/api/mail/connect', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Mail is not available.' } });
  });

  it('needs a session and the CSRF header', async () => {
    expect((await call('/api/mail/connect', { method: 'POST', cookies: [] })).status).toBe(401);
    const noCsrf = await app.fetch(
      new Request(`${ORIGIN}/api/mail/connect`, { method: 'POST', headers: { Cookie: cookie } }),
      env,
    );
    expect(noCsrf.status).toBe(403);
  });

  it('refuses when the slots are full, unless the user already holds one', async () => {
    await signIn(makeEnv({ MAIL_SLOTS: '1' }));
    await store.takeMailSlot(2002, 1, null);
    const full = await call('/api/mail/connect', { method: 'POST' });
    expect(full.status).toBe(403);
    expect(((await full.json()) as { error: Json }).error.message).toBe(
      'Mail slots are full. Self-host the server to use mail.',
    );
    await store.takeMailSlot(user.moodleUserId, 2, null);
    expect((await call('/api/mail/connect', { method: 'POST' })).status).toBe(200);
  });

  it('MAIL_SLOTS=0 takes no new connections but lets a slot holder reconnect', async () => {
    await signIn(makeEnv({ MAIL_SLOTS: '0' }));
    expect((await call('/api/mail/connect', { method: 'POST' })).status).toBe(403);
    await store.takeMailSlot(user.moodleUserId, 1, null);
    const flow = await startFlow();
    google.token = () => tokenAnswer(flow.nonce);
    expect(await callback(flow)).toBe('connected');
  });

  it('builds the Google consent URL with PKCE and binds the state to this browser', async () => {
    const flow = await startFlow();
    expect(`${flow.url.origin}${flow.url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = Object.fromEntries(flow.url.searchParams);
    expect(p).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${ORIGIN}/api/google/callback`,
      response_type: 'code',
      scope: `openid email ${READ} ${SEND}`,
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'false',
      code_challenge_method: 'S256',
    });
    expect(p.hd).toBeUndefined();
    expect(p.login_hint).toBeUndefined();
    expect(p.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.state).toMatch(/^gml_/);
    expect(flow.nonce.length).toBeGreaterThanOrEqual(16);
    expect(flow.stateCookie).toBe(`${GML_COOKIE}=${flow.state}`);
  });

  it('suggests the stored address on a reconnect', async () => {
    const first = await startFlow();
    google.token = () => tokenAnswer(first.nonce);
    expect(await callback(first)).toBe('connected');
    const second = await startFlow();
    expect(second.url.searchParams.get('login_hint')).toBe('taro@akane.waseda.jp');
    expect(second.url.searchParams.get('prompt')).toBe('consent select_account');
  });
});

describe('GET /api/google/callback', () => {
  it('stores the connection, takes the slot and audits it', async () => {
    const flow = await startFlow();
    google.token = () => tokenAnswer(flow.nonce);
    expect(await callback(flow)).toBe('connected');

    const form = google.exchanges[0];
    expect(form?.get('grant_type')).toBe('authorization_code');
    expect(form?.get('code')).toBe('code-1');
    expect(form?.get('redirect_uri')).toBe(`${ORIGIN}/api/google/callback`);
    const verifier = form?.get('code_verifier') ?? '';
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    expect(b64urlEncode(new Uint8Array(digest))).toBe(flow.url.searchParams.get('code_challenge'));

    const row = await store.getMailCredential(user.id);
    expect(row).toMatchObject({ address: 'taro@akane.waseda.jp', status: 'active', lastUsedAt: null, lastError: null });
    expect(row?.googleSub).toBe('110169484474386276334');
    expect(row?.scopes).toContain(SEND);
    expect(await key.decrypt(row?.refreshEnc ?? '')).toBe('rt-new');
    expect(await store.hasMailSlot(user.moodleUserId)).toBe(true);
    expect(google.revoked).toEqual([]);
    const audit = await store.listAudit(user.id, { limit: 5 });
    expect(audit.map((a) => [a.action, a.detail])).toContainEqual(['mail:connect', { canSend: true }]);

    // the state is single use
    expect(await callback(flow)).toBe('expired');
  });

  /** Connects with the refresh token rt-old (claims override the default account). */
  async function connectOld(claims: Json = {}): Promise<void> {
    const first = await startFlow();
    google.token = () => tokenAnswer(first.nonce, { claims, body: { refresh_token: 'rt-old' } });
    expect(await callback(first)).toBe('connected');
  }

  async function storedRow(): Promise<MailCredentialRow> {
    const row = await store.getMailCredential(user.id);
    if (!row) throw new Error('no stored row');
    return row;
  }

  const storedToken = async (): Promise<string> => key.decrypt((await storedRow()).refreshEnc ?? '');

  it('never revokes on a reconnect with the same Google account (Google would end the whole grant)', async () => {
    await connectOld({ email: 'taro@akane.waseda.jp' });
    const second = await startFlow();
    // the address may differ in case or alias: the account id decides
    google.token = () => tokenAnswer(second.nonce, { claims: { email: 'Taro.Alias@akane.waseda.jp' } });
    expect(await callback(second)).toBe('connected');
    expect(google.revoked).toEqual([]);
    expect(await storedToken()).toBe('rt-new');
  });

  it('revokes the previous token of another Google account, after the new row is stored', async () => {
    await connectOld({ sub: 'other-account', email: 'jiro@akane.waseda.jp' });
    const second = await startFlow();
    google.token = () => tokenAnswer(second.nonce);
    expect(await callback(second)).toBe('connected');
    expect(google.revoked).toEqual(['rt-old']);
    expect((await store.getMailCredential(user.id))?.address).toBe('taro@akane.waseda.jp');
  });

  it('compares the address when the stored row has no Google account id', async () => {
    await connectOld();
    await store.putMailCredential({ ...(await storedRow()), googleSub: null });
    const same = await startFlow();
    google.token = () => tokenAnswer(same.nonce, { claims: { sub: 'new-sub' }, body: { refresh_token: 'rt-mid' } });
    expect(await callback(same)).toBe('connected');
    expect(google.revoked).toEqual([]);

    await store.putMailCredential({ ...(await storedRow()), googleSub: null });
    const other = await startFlow();
    google.token = () => tokenAnswer(other.nonce, { claims: { sub: 'x', email: 'jiro@akane.waseda.jp' } });
    expect(await callback(other)).toBe('connected');
    expect(google.revoked).toEqual(['rt-mid']);
  });

  it('a failed reconnect with the same account keeps the working connection (no revoke)', async () => {
    await connectOld();
    const second = await startFlow();
    google.token = () => tokenAnswer(second.nonce, { body: { scope: `openid ${SEND}` } });
    expect(await callback(second)).toBe('scope');
    expect(google.revoked).toEqual([]);
    expect(await storedToken()).toBe('rt-old');
  });

  it('revokes the fresh grant when the stored same-account row is already invalid', async () => {
    await connectOld();
    await store.putMailCredential({ ...(await storedRow()), status: 'invalid' });
    const second = await startFlow();
    google.token = () => tokenAnswer(second.nonce, { body: { scope: `openid ${SEND}` } });
    expect(await callback(second)).toBe('scope');
    expect(google.revoked).toEqual(['rt-new']);
  });

  it('a failed reconnect with another account revokes only the new grant', async () => {
    await connectOld();
    const second = await startFlow();
    const claims = { sub: 'other-account', email: 'jiro@akane.waseda.jp' };
    google.token = () => tokenAnswer(second.nonce, { claims, body: { scope: `openid ${SEND}` } });
    expect(await callback(second)).toBe('scope');
    expect(google.revoked).toEqual(['rt-new']);
    expect(await storedToken()).toBe('rt-old');
  });

  it('revokes the fresh grant when storing it fails, and keeps the old token alive', async () => {
    await connectOld({ sub: 'other-account', email: 'jiro@akane.waseda.jp' });
    sqlite.exec("CREATE TRIGGER no_put BEFORE UPDATE ON mail_credentials BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = await startFlow();
    google.token = () => tokenAnswer(second.nonce);
    expect(await callback(second)).toBe('failed');
    expect(google.revoked).toEqual(['rt-new']);
    expect(await storedToken()).toBe('rt-old');
    expect(String(spy.mock.calls[0])).not.toContain('rt-');
    spy.mockRestore();
  });

  it('answers denied when the user declined', async () => {
    const flow = await startFlow();
    expect(await callback(flow, { error: 'access_denied' })).toBe('denied');
    expect(google.exchanges).toEqual([]);
  });

  it('answers expired for an unknown state, a cookie mismatch or another user', async () => {
    const flow = await startFlow();
    const unknown = { ...flow, state: 'gml_unknown' };
    expect(await callback(unknown, { code: 'c' }, [cookie, `${GML_COOKIE}=gml_unknown`])).toBe('expired');
    expect(await callback(flow, { code: 'c' }, [cookie, `${GML_COOKIE}=gml_other`])).toBe('expired');
    expect(await callback(flow, { code: 'c' }, [cookie])).toBe('expired');

    const other = await store.upsertUser({ moodleUserId: 1002, fullname: 'Hanako Sato', lang: 'ja' });
    const otherCookie = (await startSession(store, other.id, null)).setCookie.split(';')[0] ?? '';
    expect(await callback(flow, { code: 'c' }, [otherCookie, flow.stateCookie])).toBe('expired');
    // the state was consumed by that attempt
    expect(await callback(flow, { code: 'c' })).toBe('expired');
    expect(google.exchanges).toEqual([]);
  });

  it('answers session without a console session', async () => {
    const flow = await startFlow();
    expect(await callback(flow, { code: 'c' }, [flow.stateCookie])).toBe('session');
  });

  it('answers domain for a non-Waseda address and revokes the grant', async () => {
    const flow = await startFlow();
    google.token = () => tokenAnswer(flow.nonce, { claims: { email: 'taro@example.com', hd: 'example.com' } });
    expect(await callback(flow)).toBe('domain');
    expect(google.revoked).toEqual(['rt-new']);
    expect(await store.getMailCredential(user.id)).toBeNull();
    // Google counted the user: the slot is taken anyway
    expect(await store.hasMailSlot(user.moodleUserId)).toBe(true);
  });

  it('answers domain for a waseda.jp address outside the Waseda Workspace (no or another hd claim)', async () => {
    for (const hd of [undefined, 'example.com', 'waseda.jp.example.com']) {
      const flow = await startFlow();
      google.token = () => tokenAnswer(flow.nonce, { claims: { hd } });
      expect(await callback(flow)).toBe('domain');
    }
    expect(await store.getMailCredential(user.id)).toBeNull();
  });

  it('rejects an id_token for another client, nonce or an unverified address', async () => {
    const bad = [{ aud: 'other' }, { nonce: 'n' }, { email_verified: false }, { iss: 'evil.example.org' }, { sub: 7 }];
    for (const claims of bad) {
      const flow = await startFlow();
      google.token = () => tokenAnswer(flow.nonce, { claims });
      expect(await callback(flow)).toBe('failed');
    }
    expect(await store.getMailCredential(user.id)).toBeNull();
  });

  it('answers scope when gmail.readonly was not granted', async () => {
    const flow = await startFlow();
    google.token = () => tokenAnswer(flow.nonce, { body: { scope: `openid ${SEND}` } });
    expect(await callback(flow)).toBe('scope');
    expect(google.revoked).toEqual(['rt-new']);
  });

  it('stores a read-only connection when sending was unticked', async () => {
    const flow = await startFlow();
    google.token = () => tokenAnswer(flow.nonce, { body: { scope: `openid ${READ}` } });
    expect(await callback(flow)).toBe('connected');
    const me = (await (await call('/api/me')).json()) as { mail: { connection: Json } };
    expect(me.mail.connection.canSend).toBe(false);
  });

  it('answers full when the last slot went while the user was at Google', async () => {
    await signIn(makeEnv({ MAIL_SLOTS: '1' }));
    const flow = await startFlow();
    await store.takeMailSlot(2002, 1, null);
    google.token = () => tokenAnswer(flow.nonce);
    expect(await callback(flow)).toBe('full');
    expect(google.revoked).toEqual(['rt-new']);
    expect(await store.hasMailSlot(user.moodleUserId)).toBe(false);
  });

  it('answers failed without a refresh token or when the code exchange fails', async () => {
    const flow = await startFlow();
    google.token = () => tokenAnswer(flow.nonce, { body: { refresh_token: undefined } });
    expect(await callback(flow)).toBe('failed');
    expect(google.revoked).toEqual(['at-new']);

    const again = await startFlow();
    google.token = () => Response.json({ error: 'invalid_grant', error_description: 'Bad code' }, { status: 400 });
    expect(await callback(again)).toBe('failed');
    expect(await store.getMailCredential(user.id)).toBeNull();
  });
});

describe('DELETE /api/mail and GET /api/me', () => {
  it('reports the mail block, disconnects and revokes', async () => {
    let me = (await (await call('/api/me')).json()) as { mail: Json };
    expect(me.mail).toEqual({ connection: null, slotsLeft: 80, hasSlot: false, idleDays: 90 });

    const flow = await startFlow();
    google.token = () => tokenAnswer(flow.nonce);
    expect(await callback(flow)).toBe('connected');
    me = (await (await call('/api/me')).json()) as { mail: Json };
    expect(me.mail).toMatchObject({ slotsLeft: 79, hasSlot: true, idleDays: 90 });
    expect(me.mail.connection).toMatchObject({
      address: 'taro@akane.waseda.jp',
      canSend: true,
      status: 'active',
      lastUsedAt: null,
      endReason: null,
    });

    const del = await call('/api/mail', { method: 'DELETE' });
    expect(await del.json()).toEqual({ ok: true });
    expect(google.revoked).toEqual(['rt-new']);
    expect(await store.getMailCredential(user.id)).toBeNull();
    const audit = await store.listAudit(user.id, { limit: 5 });
    expect(audit.map((a) => a.action)).toContain('mail:disconnect');
    me = (await (await call('/api/me')).json()) as { mail: Json };
    expect(me.mail).toMatchObject({ connection: null, hasSlot: true, slotsLeft: 79 });
  });

  it('explains how a connection ended without its error text', async () => {
    const base = { address: 'taro@akane.waseda.jp', scopes: [READ], connectedAt: 1, lastUsedAt: null };
    const row = { ...base, userId: user.id, googleSub: null, idleTriedAt: null };
    await store.putMailCredential({ ...row, refreshEnc: null, status: 'invalid', lastError: 'x' });
    let me = (await (await call('/api/me')).json()) as { mail: { connection: Json } };
    expect(me.mail.connection.endReason).toBe('idle');
    expect(JSON.stringify(me.mail)).not.toContain('lastError');
    await store.updateMailCredential(user.id, { refreshEnc: 'enc' });
    me = (await (await call('/api/me')).json()) as { mail: { connection: Json } };
    expect(me.mail.connection.endReason).toBe('revoked');
  });

  it('deletes the row even when Google cannot be asked to revoke, with a warning naming no token', async () => {
    const flow = await startFlow();
    google.token = () => tokenAnswer(flow.nonce);
    expect(await callback(flow)).toBe('connected');
    google.revokeDown = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await call('/api/mail', { method: 'DELETE' })).status).toBe(200);
    expect(await store.getMailCredential(user.id)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toContain('rt-new');
    warn.mockRestore();

    // an undecryptable token is warned about by name and the row still goes
    await store.putMailCredential({
      userId: user.id,
      address: 'taro@akane.waseda.jp',
      googleSub: null,
      refreshEnc: 'not-encrypted',
      scopes: [READ],
      status: 'active',
      connectedAt: 1,
      lastUsedAt: null,
      lastError: null,
      idleTriedAt: null,
    });
    const warn2 = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await call('/api/mail', { method: 'DELETE' })).status).toBe(200);
    expect(await store.getMailCredential(user.id)).toBeNull();
    expect(String(warn2.mock.calls[0])).not.toContain('not-encrypted');
    warn2.mockRestore();
  });

  it('is null when mail is not configured; unlimited slots read null', async () => {
    await signIn(makeEnv({ GOOGLE_CLIENT_ID: '' }));
    expect(((await (await call('/api/me')).json()) as Json).mail).toBeNull();
    await signIn(makeEnv({ MAIL_SLOTS: 'off', MAIL_IDLE_DAYS: 'off' }));
    const me = (await (await call('/api/me')).json()) as { mail: Json };
    expect(me.mail).toMatchObject({ slotsLeft: null, idleDays: null });
    // 0 stops new connections; 0 idle days is no valid setting (default)
    await signIn(makeEnv({ MAIL_SLOTS: '0', MAIL_IDLE_DAYS: '0' }));
    const zero = (await (await call('/api/me')).json()) as { mail: Json };
    expect(zero.mail).toMatchObject({ slotsLeft: 0, idleDays: 90 });
  });
});
