import { beforeEach, describe, expect, it } from 'vitest';
import type { CredentialRow, UserRow } from '../../src/core/context';
import { importMasterKey, type MasterKey, sha256Hex } from '../../src/core/crypto';
import { AUTOLOGIN_RETRY_MS, refreshCredential } from '../../src/core/services/credential-renewal';
import { MemoryStore } from '../../src/node/store-memory';
import { fakeMoodleWeb } from '../helpers/fake-moodle-web';

const OLD = 'a'.repeat(32);
const NEW = 'c'.repeat(32);
const OTHER = 'e'.repeat(32);
const LIVE = 'MoodleSession=live01';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 21)));

let key: MasterKey;
let store: MemoryStore;
let user: UserRow;

type Seed = Partial<CredentialRow> & { session?: string; privateToken?: string; token?: string };

/** Stores a credential and returns it as a caller would have read it. */
async function seed(over: Seed = {}): Promise<CredentialRow> {
  const { session, privateToken, token = OLD, ...row } = over;
  await store.putCredential({
    userId: user.id,
    tokenEnc: await key.encrypt(token),
    privateTokenEnc: privateToken ? await key.encrypt(privateToken) : null,
    tokenHash: await sha256Hex(token),
    tokenHint: token.slice(-4),
    status: 'active',
    connectedVia: 'bookmarklet',
    connectedAt: 1000,
    lastOkAt: 1000,
    lastError: null,
    ...row,
  });
  const sessionEnc = session ? await key.encrypt(session) : null;
  await store.updateCredentialStatus(user.id, {
    sessionEnc,
    sessionOkAt: session ? 1 : null,
    autologinAt: row.autologinAt ?? null,
  });
  return cred();
}

const cred = async () => {
  const c = await store.getCredential(user.id);
  if (!c) throw new Error('credential missing');
  return c;
};
const plain = async (enc: string | null | undefined) => (enc ? key.decrypt(enc) : null);
const renewAudits = async () => (await store.listAudit(user.id, { limit: 10 })).filter((r) => r.action === 'renew');
const deps = (web: ReturnType<typeof fakeMoodleWeb>) => ({ store, key, fetch: web.fetch });

beforeEach(async () => {
  key = await importMasterKey(MASTER_KEY);
  store = new MemoryStore();
  user = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
});

describe('refreshCredential with a stored session', () => {
  it('confirms the same token with one launch.php call and stamps the session', async () => {
    const c = await seed({ session: LIVE });
    const web = fakeMoodleWeb({ token: OLD, live: new Set([LIVE]) });
    const before = Date.now();
    expect(await refreshCredential(deps(web), user, c, { autologin: true })).toEqual({
      status: 'kept',
      token: OLD,
      calls: 1,
    });
    const now = await cred();
    expect(now.sessionOkAt).toBeGreaterThanOrEqual(before);
    expect(now.renewedAt).toBeNull();
    expect(await plain(now.tokenEnc)).toBe(OLD);
    expect(await renewAudits()).toEqual([]);
  });

  it('stores a new token with its private token, keeps the connection origin and audits a renewal', async () => {
    const c = await seed({ session: LIVE, privateToken: 'OldPriv4te' });
    const web = fakeMoodleWeb({ token: NEW, privateToken: 'NewPriv4te', live: new Set([LIVE]) });
    expect(await refreshCredential(deps(web), user, c)).toMatchObject({ status: 'renewed', token: NEW, calls: 1 });
    const now = await cred();
    expect(await plain(now.tokenEnc)).toBe(NEW);
    expect(await plain(now.privateTokenEnc)).toBe('NewPriv4te');
    expect(now).toMatchObject({
      tokenHash: await sha256Hex(NEW),
      tokenHint: NEW.slice(-4),
      status: 'active',
      connectedVia: 'bookmarklet',
      connectedAt: 1000,
    });
    expect(now.renewedAt).toBe(now.sessionOkAt);
    expect(await plain(now.sessionEnc)).toBe(LIVE);
    const audits = await renewAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: 'system', detail: { via: 'session' } });
    expect((await store.listAudit(user.id, { limit: 10 })).some((r) => r.action === 'connect')).toBe(false);
  });

  it('drops the private token of the old token when the new one comes without one', async () => {
    const c = await seed({ session: LIVE, privateToken: 'OldPriv4te' });
    await refreshCredential(deps(fakeMoodleWeb({ token: NEW, live: new Set([LIVE]) })), user, c);
    expect((await cred()).privateTokenEnc).toBeNull();
  });

  it('brings an invalid credential back while the session lives', async () => {
    const c = await seed({ session: LIVE, status: 'invalid', lastError: 'Moodle rejected the stored token.' });
    const web = fakeMoodleWeb({ token: NEW, live: new Set([LIVE]) });
    expect(await refreshCredential(deps(web), user, c)).toMatchObject({ status: 'renewed' });
    expect(await cred()).toMatchObject({ status: 'active', lastError: null });
  });

  it('forgets an ended session and opens a new one with the private token (four calls)', async () => {
    const c = await seed({ session: LIVE, privateToken: 'Priv4teTok3n' });
    const web = fakeMoodleWeb({ token: OLD, newCookie: 'MoodleSession=fresh01' });
    expect(await refreshCredential(deps(web), user, c, { autologin: true })).toEqual({
      status: 'kept',
      token: OLD,
      calls: 4,
    });
    expect(web.requests.map((r) => r.path)).toEqual([
      '/admin/tool/mobile/launch.php',
      '/webservice/rest/server.php',
      '/admin/tool/mobile/autologin.php',
      '/admin/tool/mobile/launch.php',
    ]);
    expect(web.requests[3]?.cookie).toBe('MoodleSession=fresh01');
    const now = await cred();
    expect(await plain(now.sessionEnc)).toBe('MoodleSession=fresh01');
    expect(now.autologinAt).not.toBeNull();
    expect(now.sessionOkAt).not.toBeNull();
  });

  it('without autologin, an ended session is forgotten and nothing else happens', async () => {
    const c = await seed({ session: LIVE, privateToken: 'Priv4teTok3n' });
    expect(await refreshCredential(deps(fakeMoodleWeb()), user, c)).toEqual({
      status: 'skipped',
      reason: 'no_session',
      calls: 1,
    });
    expect((await cred()).sessionEnc).toBeNull();
  });

  it('keeps the session when Moodle is unreachable', async () => {
    const c = await seed({ session: LIVE });
    expect(await refreshCredential(deps(fakeMoodleWeb({ down: true })), user, c)).toEqual({
      status: 'failed',
      reason: 'unavailable',
      calls: 1,
    });
    expect(await plain((await cred()).sessionEnc)).toBe(LIVE);
  });
});

describe('refreshCredential without a session', () => {
  it('opens a session by autologin and fetches the token (three calls)', async () => {
    const c = await seed({ privateToken: 'Priv4teTok3n' });
    const web = fakeMoodleWeb({ token: OLD });
    expect(await refreshCredential(deps(web), user, c, { autologin: true })).toMatchObject({
      status: 'kept',
      calls: 3,
    });
    expect(web.requests[0]?.body?.get('privatetoken')).toBe('Priv4teTok3n');
    expect(await plain((await cred()).sessionEnc)).toBe('MoodleSession=fresh01');
  });

  it('records a refusal (app required, rate limit) without throwing and stamps the attempt', async () => {
    for (const code of ['apprequired', 'autologinkeygenerationlockout']) {
      const c = await seed({ privateToken: 'Priv4teTok3n' });
      const out = await refreshCredential(deps(fakeMoodleWeb({ keyError: code })), user, c, { autologin: true });
      expect(out).toEqual({ status: 'failed', reason: code, calls: 1 });
      const now = await cred();
      expect(now.sessionEnc).toBeNull();
      expect(now.autologinAt).not.toBeNull();
      expect(now.status).toBe('active'); // the token keeps working until it expires
    }
  });

  it('records a key that autologin.php rejects (another IP)', async () => {
    const c = await seed({ privateToken: 'Priv4teTok3n' });
    const out = await refreshCredential(deps(fakeMoodleWeb({ rejectKey: true })), user, c, { autologin: true });
    expect(out).toEqual({ status: 'failed', reason: 'autologin_rejected', calls: 2 });
    expect((await cred()).sessionEnc).toBeNull();
  });

  it('saves the session before launch.php: a failed launch is retried from it, without another autologin', async () => {
    const c = await seed({ privateToken: 'Priv4teTok3n' });
    const web = fakeMoodleWeb({ token: NEW, launchDown: true });
    expect(await refreshCredential(deps(web), user, c, { autologin: true })).toEqual({
      status: 'failed',
      reason: 'unavailable',
      calls: 3,
    });
    const saved = await cred();
    expect(await plain(saved.sessionEnc)).toBe('MoodleSession=fresh01');
    expect(saved.sessionOkAt).toBeNull(); // not confirmed yet

    web.state.launchDown = false;
    web.requests.length = 0;
    expect(await refreshCredential(deps(web), user, saved, { autologin: true })).toMatchObject({
      status: 'renewed',
      token: NEW,
      calls: 1,
    });
    expect(web.requests.map((r) => r.path)).toEqual(['/admin/tool/mobile/launch.php']);
    expect((await cred()).sessionOkAt).not.toBeNull();
  });

  it('waits AUTOLOGIN_RETRY_MS after an attempt, unless the credential was connected since', async () => {
    const web = fakeMoodleWeb();
    const recent = Date.now() - 60_000;
    const waiting = await seed({ privateToken: 'Priv4teTok3n', autologinAt: recent, connectedAt: recent - 1 });
    expect(await refreshCredential(deps(web), user, waiting, { autologin: true })).toEqual({
      status: 'skipped',
      reason: 'retry_later',
      calls: 0,
    });
    expect(web.requests).toEqual([]);

    const due = await seed({ privateToken: 'Priv4teTok3n', autologinAt: Date.now() - AUTOLOGIN_RETRY_MS - 1 });
    expect(await refreshCredential(deps(web), user, due, { autologin: true })).toMatchObject({ status: 'kept' });

    const reconnected = await seed({ privateToken: 'Priv4teTok3n', autologinAt: recent, connectedAt: recent + 1 });
    expect(reconnected.sessionEnc).toBeNull();
    expect(await refreshCredential(deps(web), user, reconnected, { autologin: true })).toMatchObject({
      status: 'kept',
    });
  });

  it('lets only one of two overlapping setups claim the autologin', async () => {
    const c = await seed({ privateToken: 'Priv4teTok3n' });
    const web = fakeMoodleWeb();
    const [a, b] = await Promise.all([
      refreshCredential(deps(web), user, c, { autologin: true }),
      refreshCredential(deps(web), user, c, { autologin: true }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['kept', 'skipped']);
    expect([a.reason, b.reason]).toContain('conflict');
    expect(web.requests.filter((r) => r.path === '/webservice/rest/server.php')).toHaveLength(1);
  });

  it('needs a manual reconnect without a private token, for an invalid credential, or without autologin', async () => {
    const web = fakeMoodleWeb();
    const plainCred = await seed();
    expect(await refreshCredential(deps(web), user, plainCred, { autologin: true })).toMatchObject({
      status: 'skipped',
      reason: 'no_session',
    });
    const invalid = await seed({ privateToken: 'Priv4teTok3n', status: 'invalid' });
    expect(await refreshCredential(deps(web), user, invalid, { autologin: true })).toMatchObject({
      status: 'skipped',
    });
    const noAutologin = await seed({ privateToken: 'Priv4teTok3n' });
    expect(await refreshCredential(deps(web), user, noAutologin)).toMatchObject({ status: 'skipped' });
    expect(web.requests).toEqual([]);
  });

  it('checks the room it is given before each step', async () => {
    const c = await seed({ privateToken: 'Priv4teTok3n' });
    const web = fakeMoodleWeb();
    const room = (moodle: number) => moodle <= 2;
    expect(await refreshCredential(deps(web), user, c, { autologin: true, room })).toEqual({
      status: 'skipped',
      reason: 'budget',
      calls: 0,
    });
    expect((await cred()).autologinAt).toBeNull();
  });
});

describe('refreshCredential under concurrent writers', () => {
  it('does not erase a session another refresh stored meanwhile (stale "session ended")', async () => {
    const read = await seed({ session: LIVE, privateToken: 'Priv4teTok3n' });
    const newer = await key.encrypt('MoodleSession=other02');
    await store.updateCredentialStatus(user.id, { sessionEnc: newer, sessionOkAt: 5 });
    const web = fakeMoodleWeb(); // LIVE has ended
    expect(await refreshCredential(deps(web), user, read, { autologin: true })).toMatchObject({
      status: 'skipped',
      reason: 'conflict',
    });
    expect((await cred()).sessionEnc).toBe(newer);
    expect(web.requests.map((r) => r.path)).toEqual(['/admin/tool/mobile/launch.php']); // no autologin
  });

  it('keeps a private token that arrived while a same-token keepalive was in flight', async () => {
    const read = await seed({ session: LIVE }); // no private token yet
    const web = fakeMoodleWeb({ token: OLD, live: new Set([LIVE]) }); // launch.php sends no private token
    const delivered = await key.encrypt('Deliver3dP');
    const inFlight = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // an extension refresh stores the same token plus a private token while launch.php answers
      await store.updateCredentialStatus(user.id, { privateTokenEnc: delivered });
      return web.fetch(input, init);
    }) as typeof fetch;
    expect(await refreshCredential({ store, key, fetch: inFlight }, user, read)).toMatchObject({ status: 'kept' });
    expect((await cred()).privateTokenEnc).toBe(delivered);
  });

  it('does not overwrite a token stored by a reconnect meanwhile, and hands that one back', async () => {
    const read = await seed({ session: LIVE });
    await store.putCredential({ ...read, tokenEnc: await key.encrypt(OTHER), tokenHash: await sha256Hex(OTHER) });
    const web = fakeMoodleWeb({ token: NEW, live: new Set([LIVE]) });
    expect(await refreshCredential(deps(web), user, read)).toMatchObject({
      status: 'kept',
      reason: 'concurrent',
      token: OTHER,
    });
    expect(await plain((await cred()).tokenEnc)).toBe(OTHER);
    expect(await renewAudits()).toEqual([]);
  });
});
