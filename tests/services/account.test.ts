import { describe, expect, it } from 'vitest';
import { type MasterKey, sha256Hex } from '../../src/core/crypto';
import { Forbidden, InvalidInput, MoodleError, NeedsReconnect, NotFound } from '../../src/core/errors';
import { MOODLE_URL, md5Hex } from '../../src/core/moodle/launch';
import {
  type ConnectDeps,
  connectFromLaunch,
  refreshFromLaunch,
  toCredentialInfo,
  toUserInfo,
} from '../../src/core/services/account';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import { siteInfo, TOKEN_A, TOKEN_B } from '../fixtures/be4/site-info';
import { createFakeMoodle, createMemoryStoreForTests } from '../helpers/fake-context-be4';

const key = {
  encrypt: async (s: string) => `enc(${s})`,
  decrypt: async (s: string) => s.slice(4, -1),
} as unknown as MasterKey;

function setup(opts: { info?: unknown | (() => unknown); allow?: boolean } = {}) {
  const store = createMemoryStoreForTests();
  const clients: Array<{ token: string; userId: number }> = [];
  const registrationChecks: number[] = [];
  const deps: ConnectDeps = {
    store,
    key,
    makeClient(token, moodleUserId) {
      clients.push({ token, userId: moodleUserId });
      return createFakeMoodle({
        moodleUserId,
        handlers: { core_webservice_get_site_info: opts.info ?? siteInfo() },
      });
    },
    allowRegistration(id) {
      registrationChecks.push(id);
      return opts.allow ?? true;
    },
  };
  return { store, deps, clients, registrationChecks };
}

/** ltgopenlmsapp://token=<base64(md5(wwwroot+passport):::token[:::privatetoken])> */
function launchUrl(token: string, passport: string, privateToken?: string) {
  const parts = [md5Hex(MOODLE_URL + passport), token, ...(privateToken ? [privateToken] : [])];
  return `ltgopenlmsapp://token=${btoa(parts.join(':::'))}`;
}

describe('connectFromLaunch', () => {
  it('creates the user and an encrypted active credential', async () => {
    const { deps, store, clients, registrationChecks } = setup();
    const res = await connectFromLaunch(deps, { launch: TOKEN_A, via: 'paste' });

    expect(res.created).toBe(true);
    expect(res.tokenChanged).toBe(true);
    expect(res.user).toMatchObject({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
    expect(clients).toEqual([{ token: TOKEN_A, userId: 0 }]);
    expect(registrationChecks).toEqual([1001]);

    const cred = store.credentials.get(res.user.id)!;
    expect(cred).toMatchObject({
      tokenEnc: `enc(${TOKEN_A})`,
      privateTokenEnc: null,
      tokenHash: await sha256Hex(TOKEN_A),
      tokenHint: TOKEN_A.slice(-4),
      status: 'active',
      connectedVia: 'paste',
      lastError: null,
    });
    expect(cred.lastOkAt).toBe(cred.connectedAt);
    expect(store.auditLog).toHaveLength(1);
    expect(store.auditLog[0]).toMatchObject({
      userId: res.user.id,
      action: 'connect',
      actor: 'console',
      detail: { via: 'paste', created: true, tokenChanged: true },
    });
    expect(JSON.stringify(store.auditLog)).not.toContain(TOKEN_A);
  });

  it('parses full launch URLs including the private token', async () => {
    const { deps, store } = setup();
    const res = await connectFromLaunch(deps, {
      launch: launchUrl(TOKEN_A, 'p1', 'P'.repeat(64)),
      via: 'bookmarklet',
      passport: 'p1',
    });
    const cred = store.credentials.get(res.user.id)!;
    expect(cred.tokenEnc).toBe(`enc(${TOKEN_A})`);
    expect(cred.privateTokenEnc).toBe(`enc(${'P'.repeat(64)})`);
  });

  it('reconnecting with the same token is not a token change and keeps the private token', async () => {
    const { deps, store } = setup();
    const first = await connectFromLaunch(deps, {
      launch: launchUrl(TOKEN_A, 'p1', 'P'.repeat(64)),
      via: 'bookmarklet',
    });
    const second = await connectFromLaunch(deps, { launch: TOKEN_A, via: 'paste' });
    expect(second.created).toBe(false);
    expect(second.tokenChanged).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    const cred = store.credentials.get(first.user.id)!;
    expect(cred.privateTokenEnc).toBe(`enc(${'P'.repeat(64)})`);
    expect(cred.connectedVia).toBe('paste');
    expect(store.users.size).toBe(1);
  });

  it('a different token reports tokenChanged, drops the old private token and reactivates', async () => {
    const { deps, store } = setup();
    const first = await connectFromLaunch(deps, { launch: launchUrl(TOKEN_A, 'p1', 'P'.repeat(64)), via: 'paste' });
    await store.updateCredentialStatus(first.user.id, { status: 'invalid', lastError: 'expired' });
    const second = await connectFromLaunch(deps, { launch: TOKEN_B, via: 'paste' });
    expect(second.tokenChanged).toBe(true);
    expect(store.credentials.get(first.user.id)).toMatchObject({
      tokenEnc: `enc(${TOKEN_B})`,
      privateTokenEnc: null,
      status: 'active',
      lastError: null,
    });
  });

  it('only checks registration for unknown users', async () => {
    const closed = setup({ allow: false });
    await expect(connectFromLaunch(closed.deps, { launch: TOKEN_A, via: 'paste' })).rejects.toThrow(
      'This service is not open for new accounts yet.',
    );
    await expect(connectFromLaunch(closed.deps, { launch: TOKEN_A, via: 'paste' })).rejects.toBeInstanceOf(Forbidden);
    expect(closed.store.users.size).toBe(0);
    expect(closed.store.credentials.size).toBe(0);

    await closed.store.upsertUser({ moodleUserId: 1001, fullname: 'Old Name', lang: 'en' });
    const res = await connectFromLaunch(closed.deps, { launch: TOKEN_A, via: 'paste' });
    expect(res.created).toBe(false);
    expect(res.user.fullname).toBe('Taro Yamada'); // refreshed from site info
  });

  it('rejects tokens from another site, bad input and rejected tokens', async () => {
    const other = setup({ info: siteInfo({ siteurl: 'https://moodle.example.com' }) });
    await expect(connectFromLaunch(other.deps, { launch: TOKEN_A, via: 'paste' })).rejects.toThrow(
      'does not belong to Waseda Moodle',
    );

    const noUser = setup({ info: siteInfo({ userid: 0 }) });
    await expect(connectFromLaunch(noUser.deps, { launch: TOKEN_A, via: 'paste' })).rejects.toBeInstanceOf(
      InvalidInput,
    );

    const { deps, clients } = setup();
    await expect(connectFromLaunch(deps, { launch: 'not a launch link', via: 'paste' })).rejects.toBeInstanceOf(
      InvalidInput,
    );
    expect(clients).toHaveLength(0);

    const rejected = setup({
      info: () => {
        throw new NeedsReconnect();
      },
    });
    await expect(connectFromLaunch(rejected.deps, { launch: TOKEN_A, via: 'paste' })).rejects.toThrow(
      'did not accept this sign-in link',
    );

    const invalid = setup({
      info: () => {
        throw new MoodleError('Invalid token', 'invalidtoken');
      },
    });
    await expect(connectFromLaunch(invalid.deps, { launch: TOKEN_A, via: 'paste' })).rejects.toBeInstanceOf(
      InvalidInput,
    );
  });

  it('tolerates a trailing slash in siteurl and falls back for missing names', async () => {
    const { deps } = setup({
      info: siteInfo({ siteurl: 'https://wsdmoodle.waseda.jp/', fullname: '  ', username: 'taro.yamada', lang: '' }),
    });
    const res = await connectFromLaunch(deps, { launch: TOKEN_A, via: 'stdio' });
    expect(res.user).toMatchObject({ fullname: 'taro.yamada', lang: 'en' });
  });
});

describe('refreshFromLaunch', () => {
  it('never creates users', async () => {
    const { deps, store } = setup();
    await expect(refreshFromLaunch(deps, { launch: TOKEN_A })).rejects.toBeInstanceOf(NotFound);
    expect(store.users.size).toBe(0);
    expect(store.credentials.size).toBe(0);
  });

  it('confirms an unchanged token without rewriting the credential', async () => {
    const { deps, store } = setup();
    const first = await connectFromLaunch(deps, { launch: TOKEN_A, via: 'bookmarklet' });
    await store.updateCredentialStatus(first.user.id, { status: 'invalid', lastOkAt: 5, lastError: 'old' });
    const res = await refreshFromLaunch(deps, { launch: TOKEN_A });
    expect(res.tokenChanged).toBe(false);
    const cred = store.credentials.get(first.user.id)!;
    expect(cred).toMatchObject({ status: 'active', lastError: null, connectedVia: 'bookmarklet' });
    expect(cred.lastOkAt).not.toBe(5);
    expect(store.auditLog[store.auditLog.length - 1]).toMatchObject({
      action: 'connect',
      actor: 'extension',
      detail: { refresh: true, tokenChanged: false },
    });
  });

  it('stores a new token as an extension connection', async () => {
    const { deps, store } = setup();
    const first = await connectFromLaunch(deps, { launch: TOKEN_A, via: 'bookmarklet' });
    const res = await refreshFromLaunch(deps, { launch: TOKEN_B });
    expect(res.tokenChanged).toBe(true);
    expect(store.credentials.get(first.user.id)).toMatchObject({
      tokenEnc: `enc(${TOKEN_B})`,
      connectedVia: 'extension',
      status: 'active',
    });
  });
});

describe('toUserInfo / toCredentialInfo', () => {
  it('maps rows to API shapes with ISO JST times', async () => {
    const { deps, store } = setup();
    const { user } = await connectFromLaunch(deps, { launch: TOKEN_A, via: 'paste' });
    user.createdAt = Date.UTC(2026, 9, 14, 3, 0, 0);
    expect(toUserInfo(user)).toEqual({
      id: user.id,
      moodleUserId: 1001,
      fullname: 'Taro Yamada',
      lang: 'ja',
      settings: DEFAULT_SETTINGS,
      createdAt: '2026-10-14T12:00:00+09:00',
    });
    const cred = store.credentials.get(user.id)!;
    cred.connectedAt = Date.UTC(2026, 9, 14, 3, 0, 0);
    cred.lastOkAt = null;
    cred.lastError = 'boom';
    expect(toCredentialInfo(cred)).toEqual({
      status: 'active',
      connectedVia: 'paste',
      connectedAt: '2026-10-14T12:00:00+09:00',
      lastOkAt: null,
      lastError: 'boom',
      tokenHint: TOKEN_A.slice(-4),
    });
    expect(Object.keys(toCredentialInfo(cred))).not.toContain('tokenEnc');
  });

  it('fills missing settings with defaults', () => {
    const info = toUserInfo({
      id: 3,
      moodleUserId: 3,
      fullname: 'X',
      lang: 'en',
      settings: { writeMode: 'off' } as never,
      createdAt: 0,
      lastSeenAt: null,
    });
    expect(info.settings).toEqual({ ...DEFAULT_SETTINGS, writeMode: 'off' });
  });
});
