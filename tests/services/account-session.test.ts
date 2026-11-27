import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MasterKey, sha256Hex } from '../../src/core/crypto';
import { Forbidden, InvalidInput, MoodleError, NeedsReconnect, NotFound, RateLimited } from '../../src/core/errors';
import { identifySession } from '../../src/core/moodle/web/identify';
import {
  type ConnectDeps,
  connectAccount,
  connectFromLaunch,
  connectFromSession,
  isUsable,
  refreshFromSession,
  toCredentialInfo,
} from '../../src/core/services/account';
import { siteInfo, TOKEN_A } from '../fixtures/be4/site-info';
import { createFakeMoodle, createMemoryStoreForTests } from '../helpers/fake-context-be4';

vi.mock('../../src/core/moodle/web/identify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/moodle/web/identify')>()),
  identifySession: vi.fn(),
}));

const key = {
  encrypt: async (s: string) => `enc(${s})`,
  decrypt: async (s: string) => s.slice(4, -1),
} as unknown as MasterKey;

const VALUE_A = 'sessionvalue0000000000aaaa';
const VALUE_B = 'sessionvalue0000000000bbbb';
const COOKIE_A = `MoodleSession=${VALUE_A}`;
const COOKIE_B = `MoodleSession=${VALUE_B}`;

/** The Moodle user a cookie belongs to; unknown cookies have ended. */
let owners: Map<string, { id: number; name: string; lang: string | null }>;

beforeEach(() => {
  owners = new Map([
    [COOKIE_A, { id: 1001, name: 'Taro Yamada', lang: 'ja' }],
    [COOKIE_B, { id: 1001, name: 'Taro Yamada', lang: null }],
  ]);
  vi.mocked(identifySession)
    .mockReset()
    .mockImplementation(async (_fetch, cookie) => {
      const who = owners.get(cookie);
      if (!who) throw new NeedsReconnect('The Moodle session has ended.');
      return { moodleUserId: who.id, fullname: who.name, lang: who.lang, sesskey: `key-${who.id}`, cookie };
    });
});

function setup(opts: { allow?: boolean; info?: () => unknown } = {}) {
  const store = createMemoryStoreForTests();
  const deps: ConnectDeps = {
    store,
    key,
    makeClient: (_token, moodleUserId) =>
      createFakeMoodle({
        moodleUserId,
        handlers: { core_webservice_get_site_info: opts.info ?? (() => siteInfo()) },
      }),
    allowRegistration: () => opts.allow ?? true,
  };
  return { store, deps };
}

describe('connectFromSession', () => {
  it('creates the account with an encrypted session and sesskey and no token', async () => {
    const { store, deps } = setup();
    const res = await connectFromSession(deps, { session: VALUE_A, via: 'paste' });
    expect(res).toMatchObject({ created: true, changed: true, user: { moodleUserId: 1001, lang: 'ja' } });
    const cred = store.credentials.get(res.user.id);
    expect(cred).toMatchObject({
      tokenEnc: null,
      tokenHash: null,
      tokenHint: null,
      sessionEnc: `enc(${COOKIE_A})`,
      sesskeyEnc: 'enc(key-1001)',
      status: 'active',
      connectedVia: 'paste',
      lastError: null,
    });
    expect(cred?.sessionOkAt).toBe(cred?.connectedAt);
  });

  it('keeps the stored token of the same user and brings an invalid credential back', async () => {
    const { store, deps } = setup();
    const first = await connectFromLaunch(deps, { launch: TOKEN_A, via: 'paste' });
    await store.updateCredentialStatus(first.user.id, { status: 'invalid', lastError: 'rejected' });
    const res = await connectFromSession(deps, { session: COOKIE_A, via: 'extension' });
    expect(res).toMatchObject({ created: false, changed: true });
    expect(store.credentials.get(first.user.id)).toMatchObject({
      tokenEnc: `enc(${TOKEN_A})`,
      tokenHash: await sha256Hex(TOKEN_A),
      sessionEnc: `enc(${COOKIE_A})`,
      status: 'active',
      lastError: null,
      connectedVia: 'extension',
    });
  });

  it('keeps the known language when Moodle does not say it', async () => {
    const { deps } = setup();
    await connectFromSession(deps, { session: COOKIE_A, via: 'paste' });
    const res = await connectFromSession(deps, { session: COOKIE_B, via: 'paste' });
    expect(res.user.lang).toBe('ja');
  });

  it('connects another Moodle user to that user’s own account', async () => {
    const { store, deps } = setup();
    owners.set(COOKIE_B, { id: 1002, name: '', lang: 'en' });
    const a = await connectFromSession(deps, { session: COOKIE_A, via: 'paste' });
    const b = await connectFromSession(deps, { session: COOKIE_B, via: 'paste' });
    expect(b.user.id).not.toBe(a.user.id);
    expect(b.user.fullname).toBe('User 1002');
    expect(store.credentials.get(a.user.id)?.sessionEnc).toBe(`enc(${COOKIE_A})`);
  });

  it('applies the registration policy to new accounts only', async () => {
    const closed = setup({ allow: false });
    const refused = connectFromSession(closed.deps, { session: COOKIE_A, via: 'paste' });
    await expect(refused).rejects.toBeInstanceOf(Forbidden);
    expect(closed.store.credentials.size).toBe(0);
    await closed.store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
    await expect(connectFromSession(closed.deps, { session: COOKIE_A, via: 'paste' })).resolves.toMatchObject({
      created: false,
    });
  });

  it('rejects text that is no session cookie, and an ended session, without storing anything', async () => {
    const { store, deps } = setup();
    await expect(connectFromSession(deps, { session: 'nope', via: 'paste' })).rejects.toBeInstanceOf(InvalidInput);
    expect(identifySession).not.toHaveBeenCalled();
    const ended = connectFromSession(deps, { session: 'endedsession000000000000', via: 'paste' });
    await expect(ended).rejects.toBeInstanceOf(NeedsReconnect);
    expect(store.credentials.size).toBe(0);
  });

  it('stores an app token sent along only when it is this user’s, and ignores one Moodle refuses', async () => {
    const same = setup();
    const res = await connectFromSession(same.deps, { session: COOKIE_A, launch: TOKEN_A, via: 'extension' });
    expect(same.store.credentials.get(res.user.id)).toMatchObject({
      tokenEnc: `enc(${TOKEN_A})`,
      sessionEnc: `enc(${COOKIE_A})`,
    });

    const other = setup({ info: () => siteInfo({ userid: 1002 }) });
    const r2 = await connectFromSession(other.deps, { session: COOKIE_A, launch: TOKEN_A, via: 'extension' });
    expect(other.store.credentials.get(r2.user.id)?.tokenEnc).toBeNull();

    const off = setup({
      info: () => {
        throw new MoodleError('Access control exception', 'accessexception');
      },
    });
    const r3 = await connectFromSession(off.deps, { session: COOKIE_A, launch: TOKEN_A, via: 'extension' });
    expect(off.store.credentials.get(r3.user.id)).toMatchObject({ tokenEnc: null, status: 'active' });
  });
});

describe('connectAccount', () => {
  it('prefers the session, falls back to the launch link and needs one of them', async () => {
    const { store, deps } = setup();
    const web = await connectAccount(deps, { session: COOKIE_A, via: 'paste' });
    expect(store.credentials.get(web.user.id)?.sessionEnc).toBe(`enc(${COOKIE_A})`);
    await connectAccount(deps, { launch: TOKEN_A, via: 'paste' });
    expect(store.credentials.get(web.user.id)?.tokenEnc).toBe(`enc(${TOKEN_A})`);
    await expect(connectAccount(deps, { via: 'paste' })).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe('refreshFromSession', () => {
  it('never creates an account', async () => {
    const { store, deps } = setup();
    await expect(refreshFromSession(deps, { session: COOKIE_A })).rejects.toBeInstanceOf(NotFound);
    expect(store.credentials.size).toBe(0);
  });

  it('only confirms the same session and keeps how it was connected', async () => {
    const { store, deps } = setup();
    const { user } = await connectFromSession(deps, { session: COOKIE_A, via: 'paste' });
    await store.updateCredentialStatus(user.id, { connectedAt: 5, sessionOkAt: 5 });
    expect(await refreshFromSession(deps, { session: COOKIE_A })).toMatchObject({ changed: false });
    const cred = store.credentials.get(user.id);
    expect(cred).toMatchObject({ connectedVia: 'paste', connectedAt: 5 });
    expect(cred?.sessionOkAt).toBeGreaterThan(5);
  });

  it('a new session drops the busy mark of the old one; the same session keeps it', async () => {
    const { store, deps } = setup();
    const { user } = await connectFromSession(deps, { session: COOKIE_A, via: 'paste' });
    const until = Date.now() + 60_000;
    await store.updateCredentialStatus(user.id, { busyUntil: until });
    await refreshFromSession(deps, { session: COOKIE_A });
    expect(store.credentials.get(user.id)?.busyUntil).toBe(until);
    await refreshFromSession(deps, { session: COOKIE_B });
    expect(store.credentials.get(user.id)?.busyUntil).toBeNull();
  });

  it('replaces the session after a new Moodle sign-in, so no reconnect is needed', async () => {
    const { store, deps } = setup();
    const { user } = await connectFromSession(deps, { session: COOKIE_A, via: 'paste' });
    await store.updateCredentialStatus(user.id, { sessionEnc: null, status: 'invalid', lastError: 'ended' });
    expect(await refreshFromSession(deps, { session: COOKIE_B })).toMatchObject({ changed: true });
    expect(store.credentials.get(user.id)).toMatchObject({
      sessionEnc: `enc(${COOKIE_B})`,
      status: 'active',
      lastError: null,
      connectedVia: 'extension',
    });
    const audits = await store.listAudit(user.id, { limit: 5 });
    expect(audits.some((a) => a.detail?.refresh === true && a.actor === 'extension')).toBe(true);
  });

  it('asks the caller to admit the account before writing', async () => {
    const { store, deps } = setup();
    const { user } = await connectFromSession(deps, { session: COOKIE_A, via: 'paste' });
    const admit = vi.fn(async () => {
      throw new RateLimited();
    });
    await expect(refreshFromSession(deps, { session: COOKIE_B, admit })).rejects.toBeInstanceOf(RateLimited);
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ id: user.id }));
    expect(store.credentials.get(user.id)?.sessionEnc).toBe(`enc(${COOKIE_A})`);
  });

  it('leaves the stored session alone when the sent one has ended', async () => {
    const { store, deps } = setup();
    const { user } = await connectFromSession(deps, { session: COOKIE_A, via: 'paste' });
    owners.delete(COOKIE_B);
    await expect(refreshFromSession(deps, { session: COOKIE_B })).rejects.toBeInstanceOf(NeedsReconnect);
    expect(store.credentials.get(user.id)?.sessionEnc).toBe(`enc(${COOKIE_A})`);
  });
});

describe('usable credentials', () => {
  const base = {
    userId: 1,
    tokenEnc: 'e',
    privateTokenEnc: null,
    tokenHash: 'h',
    tokenHint: 'abcd',
    status: 'active' as const,
    connectedVia: 'paste' as const,
    connectedAt: 0,
    lastOkAt: null,
    lastError: null,
  };

  it('counts a session always, a token only while accepted and the app service is on', () => {
    expect(isUsable(base, true)).toBe(true);
    expect(isUsable(base, false)).toBe(false);
    expect(isUsable({ ...base, status: 'invalid' }, true)).toBe(false);
    expect(isUsable({ ...base, status: 'invalid', tokenEnc: null, sessionEnc: 's' }, false)).toBe(true);
    expect(isUsable({ ...base, tokenEnc: null }, true)).toBe(false);
  });

  it('shows the console what still works', () => {
    expect(toCredentialInfo(base, false)).toMatchObject({ status: 'invalid', sessionOkAt: null });
    expect(toCredentialInfo(base, false).lastError).toMatch(/browser extension/);
    const ended = { ...base, tokenEnc: null, tokenHint: null, status: 'invalid' as const, lastError: 'ended' };
    expect(toCredentialInfo(ended, false)).toMatchObject({ status: 'invalid', lastError: 'ended' });
    const web = { ...ended, sessionEnc: 's', sessionOkAt: Date.UTC(2026, 10, 27) };
    expect(toCredentialInfo(web, false)).toMatchObject({
      status: 'active',
      lastError: null,
      sessionOkAt: '2026-11-27T09:00:00+09:00',
    });
    expect(Object.keys(toCredentialInfo(web, false))).not.toContain('sessionEnc');
  });
});
