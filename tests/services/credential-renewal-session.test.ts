import { beforeEach, describe, expect, it } from 'vitest';
import type { CredentialRow, UserRow } from '../../src/core/context';
import { importMasterKey, type MasterKey, sha256Hex } from '../../src/core/crypto';
import { keepSession, rejectToken, SESSION_ENDED, StoredSession } from '../../src/core/services/credential-renewal';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { fakeMoodleSession, SESSKEY } from '../helpers/fake-moodle-session';
import { fakeMoodleWeb } from '../helpers/fake-moodle-web';

const TOKEN = 'a'.repeat(32);
const NEW = 'c'.repeat(32);
const LIVE = 'MoodleSession=live01';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 41)));

let key: MasterKey;
let store: D1Store;
let user: UserRow;

interface Seed {
  session?: string;
  sesskey?: string;
  token?: string;
  privateToken?: string;
}

/** Stores a credential and returns it as a caller would have read it. */
async function seed(opts: Seed = {}): Promise<CredentialRow> {
  const { session = LIVE, sesskey, token, privateToken } = opts;
  await store.putCredential({
    userId: user.id,
    tokenEnc: token ? await key.encrypt(token) : null,
    privateTokenEnc: privateToken ? await key.encrypt(privateToken) : null,
    tokenHash: token ? await sha256Hex(token) : null,
    tokenHint: token ? token.slice(-4) : null,
    status: 'active',
    connectedVia: 'extension',
    connectedAt: 1000,
    lastOkAt: 1000,
    lastError: null,
  });
  await store.updateCredentialStatus(user.id, {
    sessionEnc: await key.encrypt(session),
    sesskeyEnc: sesskey ? await key.encrypt(sesskey) : null,
    sessionOkAt: 1,
  });
  return cred();
}

const cred = async () => {
  const c = await store.getCredential(user.id);
  if (!c) throw new Error('credential missing');
  return c;
};
const plain = async (enc: string | null | undefined) => (enc ? key.decrypt(enc) : null);
const deps = (web: { fetch: typeof fetch }) => ({ store, key, fetch: web.fetch });
const OFF = { mobileService: false };

beforeEach(async () => {
  key = await importMasterKey(MASTER_KEY);
  store = createD1Store(createTestD1().db);
  user = await store.upsertUser({ moodleUserId: 7001, fullname: 'Taro Yamada', lang: 'ja' });
});

describe('keepSession by touching', () => {
  it('reads a missing sesskey once, stores it and stamps the session', async () => {
    const web = fakeMoodleSession({ live: new Set([LIVE]) });
    const before = Date.now();
    expect(await keepSession(deps(web), user, await seed(), OFF)).toEqual({ status: 'kept', calls: 2 });
    expect(web.requests.map((r) => r.path)).toEqual(['/user/preferences.php', '/lib/ajax/service.php']);
    expect(web.requests[1]).toMatchObject({ cookie: LIVE, sesskey: SESSKEY });
    const now = await cred();
    expect(await plain(now.sesskeyEnc)).toBe(SESSKEY);
    expect(now.sessionOkAt).toBeGreaterThanOrEqual(before);

    web.requests.length = 0;
    expect(await keepSession(deps(web), user, now, OFF)).toEqual({ status: 'kept', calls: 1 });
    expect(web.requests.map((r) => r.path)).toEqual(['/lib/ajax/service.php']);
  });

  it('stores a cookie Moodle rotates, and confirms it', async () => {
    const next = 'MoodleSession=next02';
    const web = fakeMoodleSession({ live: new Set([LIVE]), rotate: new Map([[LIVE, next]]) });
    await keepSession(deps(web), user, await seed({ sesskey: SESSKEY }), OFF);
    const now = await cred();
    expect(await plain(now.sessionEnc)).toBe(next);
    expect(now.sessionOkAt).toBeGreaterThan(1);
  });

  it('forgets an ended session; without a usable token the credential is invalid', async () => {
    const web = fakeMoodleSession();
    expect(await keepSession(deps(web), user, await seed({ sesskey: SESSKEY }), OFF)).toEqual({
      status: 'ended',
      calls: 1,
    });
    expect(await cred()).toMatchObject({
      sessionEnc: null,
      sesskeyEnc: null,
      sessionOkAt: null,
      status: 'invalid',
      lastError: SESSION_ENDED,
    });
  });

  it('counts a stored token as usable only while the mobile web service is on', async () => {
    const web = fakeMoodleSession();
    await keepSession(deps(web), user, await seed({ token: TOKEN, sesskey: SESSKEY }), OFF);
    expect(await cred()).toMatchObject({ status: 'invalid', lastError: SESSION_ENDED });
    expect((await cred()).tokenEnc).not.toBeNull(); // kept for when the service returns

    // service on: the visit goes through launch.php (fakeMoodleWeb), which finds the session ended
    const app = fakeMoodleWeb({ token: NEW, live: new Set() });
    await keepSession(deps(app), user, await seed({ token: TOKEN, sesskey: SESSKEY }), { mobileService: true });
    expect(await cred()).toMatchObject({ sessionEnc: null, status: 'active' });
  });

  it('keeps the session when Moodle is unreachable and stamps the attempt', async () => {
    const web = fakeMoodleSession({ live: new Set([LIVE]), down: true });
    const before = Date.now();
    expect(await keepSession(deps(web), user, await seed({ sesskey: SESSKEY }), OFF)).toEqual({
      status: 'failed',
      reason: 'unavailable',
      calls: 1,
    });
    const now = await cred();
    expect(now.sessionEnc).not.toBeNull();
    expect(now.sessionOkAt).toBe(1);
    expect(now.sessionTriedAt).toBeGreaterThanOrEqual(before);
    expect(now.status).toBe('active');
  });

  it('checks the room it is given, counting the page read of a missing sesskey', async () => {
    const web = fakeMoodleSession({ live: new Set([LIVE]) });
    const room = (moodle: number) => moodle <= 1;
    expect(await keepSession(deps(web), user, await seed(), { ...OFF, room })).toMatchObject({
      status: 'skipped',
      reason: 'budget',
    });
    expect(web.requests).toEqual([]);
  });
});

describe('keepSession with the mobile web service on', () => {
  it('renews through launch.php when a private token is stored', async () => {
    const web = fakeMoodleWeb({ token: NEW, live: new Set([LIVE]) });
    const c = await seed({ token: TOKEN, privateToken: 'Priv4teTok3n' });
    expect(await keepSession(deps(web), user, c, { mobileService: true })).toMatchObject({ status: 'renewed' });
    expect(web.requests.map((r) => r.path)).toEqual(['/admin/tool/mobile/launch.php']);
    expect(await plain((await cred()).tokenEnc)).toBe(NEW);
  });

  it('gets an app token for a session-only credential once the service is back on (the token channel returns)', async () => {
    const web = fakeMoodleWeb({ token: NEW, live: new Set([LIVE]) });
    const c = await seed({ sesskey: SESSKEY });
    expect(c.tokenEnc).toBeNull();
    expect(await keepSession(deps(web), user, c, { mobileService: true })).toMatchObject({ status: 'renewed' });
    expect(web.requests.map((r) => r.path)).toEqual(['/admin/tool/mobile/launch.php']);
    expect(await plain((await cred()).tokenEnc)).toBe(NEW);
    expect(await cred()).toMatchObject({ status: 'active', tokenHint: NEW.slice(-4) });
  });

  it('fetches a new token for a credential whose dead token was dropped', async () => {
    const web = fakeMoodleWeb({ token: NEW, privateToken: 'NewPriv4te', live: new Set([LIVE]) });
    const c = await seed({ privateToken: 'Priv4teTok3n' });
    expect(await keepSession(deps(web), user, c, { mobileService: true })).toMatchObject({ status: 'renewed' });
    expect(await cred()).toMatchObject({ tokenHint: NEW.slice(-4), status: 'active' });
  });

  it('only touches when the service is off, whatever tokens are stored', async () => {
    const web = fakeMoodleSession({ live: new Set([LIVE]) });
    const c = await seed({ token: TOKEN, privateToken: 'Priv4teTok3n', sesskey: SESSKEY });
    expect(await keepSession(deps(web), user, c, OFF)).toMatchObject({ status: 'kept' });
    expect(web.requests.map((r) => r.path)).toEqual(['/lib/ajax/service.php']);
  });
});

describe('StoredSession', () => {
  it('never touches a newer sign-in', async () => {
    const read = await seed();
    const stored = new StoredSession({ store, key }, user.id, read.sessionEnc ?? '');
    const newer = await key.encrypt('MoodleSession=other02');
    await store.updateCredentialStatus(user.id, { sessionEnc: newer, sessionOkAt: 5 });
    await stored.update({ cookie: 'MoodleSession=stale03' });
    await stored.confirm(900);
    expect(await stored.end(false)).toBe(false);
    expect(await cred()).toMatchObject({ sessionEnc: newer, sessionOkAt: 5, status: 'active' });
  });

  it('applies later writes to the cookie it rotated to', async () => {
    const read = await seed();
    const stored = new StoredSession({ store, key }, user.id, read.sessionEnc ?? '');
    const writes = [stored.update({ cookie: 'MoodleSession=next02' }), stored.end(false)];
    expect(await Promise.all(writes)).toEqual([undefined, true]);
    expect((await cred()).sessionEnc).toBeNull();
  });
});

describe('rejectToken', () => {
  it('invalidates a credential that has nothing but the token', async () => {
    await seed({ token: TOKEN });
    await store.updateCredentialStatus(user.id, { sessionEnc: null });
    await rejectToken(store, user.id, TOKEN);
    expect(await cred()).toMatchObject({ status: 'invalid', tokenHint: TOKEN.slice(-4) });
    expect((await cred()).lastError).toBeTruthy();
  });

  it('drops only the dead token while a session is left', async () => {
    await seed({ token: TOKEN, privateToken: 'Priv4teTok3n' });
    await rejectToken(store, user.id, TOKEN);
    const now = await cred();
    expect(now).toMatchObject({ status: 'active', tokenEnc: null, tokenHash: null, tokenHint: null });
    expect(now.sessionEnc).not.toBeNull();
    expect(now.privateTokenEnc).not.toBeNull();
  });

  it('leaves a row that holds another token alone', async () => {
    await seed({ token: TOKEN });
    await rejectToken(store, user.id, NEW);
    expect(await cred()).toMatchObject({ status: 'active', tokenHint: TOKEN.slice(-4) });
  });
});
