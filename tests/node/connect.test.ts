import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, NeedsReconnect } from '../../src/core/errors';
import { connect } from '../../src/node/connect';
import { readCredentialFile, writeCredential } from '../../src/node/credential-file';

const { identifySession } = vi.hoisted(() => ({ identifySession: vi.fn() }));
vi.mock('../../src/core/moodle/web/identify', async (original) => ({
  ...(await original<typeof import('../../src/core/moodle/web/identify')>()),
  identifySession,
}));

const TOKEN = '0123456789abcdef0123456789abcdef';
const VALUE = 'abcdefghij0123456789klmnop';
const SESSION = `MoodleSession=${VALUE}`;
const SITE = 'https://wsdmoodle.waseda.jp';

/** The token REST endpoint: site info for `userid`, or Moodle's refusal once the app service is off. */
function restFetch(userid: number | 'off') {
  const body =
    userid === 'off'
      ? { exception: 'webservice_access_exception', errorcode: 'accessexception', message: 'Access control exception' }
      : { siteurl: SITE, userid, fullname: 'Taro Yamada', lang: 'ja' };
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wmm-conn-'));
  file = join(dir, 'token');
  identifySession.mockReset();
  identifySession.mockResolvedValue({
    moodleUserId: 7001,
    fullname: 'Taro Yamada',
    lang: 'ja',
    sesskey: 'KeyKey1234',
    cookie: SESSION,
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('connect', () => {
  const saved = { session: SESSION, sesskey: 'KeyKey1234', moodleUserId: 7001 };

  it('saves a pasted session cookie in any of its forms', async () => {
    for (const input of [VALUE, SESSION, `Cookie: ${SESSION}`]) {
      const result = await connect(input, { file, fetch: restFetch('off') });
      expect(result.fullname).toBe('Taro Yamada');
      expect(await readCredentialFile(file)).toEqual(saved);
    }
    expect(identifySession).toHaveBeenLastCalledWith(expect.any(Function), SESSION);
  });

  it('keeps a stored token of the same user only', async () => {
    await writeCredential(file, { token: TOKEN, moodleUserId: 7001 });
    await connect(SESSION, { file, fetch: restFetch('off') });
    expect(await readCredentialFile(file)).toEqual({ ...saved, token: TOKEN });
    await writeCredential(file, { token: TOKEN, moodleUserId: 7002 });
    await connect(SESSION, { file, fetch: restFetch('off') });
    expect(await readCredentialFile(file)).toEqual(saved);
  });

  it('asks Moodle whose a plain token file is, and drops it when that cannot be told', async () => {
    await writeFile(file, `${TOKEN}\n`);
    await connect(SESSION, { file, fetch: restFetch(7001) });
    expect(await readCredentialFile(file)).toEqual({ ...saved, token: TOKEN });
    await writeFile(file, `${TOKEN}\n`);
    await connect(SESSION, { file, fetch: restFetch('off') });
    expect(await readCredentialFile(file)).toEqual(saved);
  });

  it('saves a launch link as the token and keeps the same user’s session', async () => {
    await writeCredential(file, saved);
    await connect(`ltgopenlmsapp://token=${TOKEN}`, { file, fetch: restFetch(7001) });
    expect(await readCredentialFile(file)).toEqual({ ...saved, token: TOKEN });
    await connect(`ltgopenlmsapp://token=${TOKEN}`, { file, fetch: restFetch(7002) });
    expect(await readCredentialFile(file)).toEqual({ token: TOKEN, moodleUserId: 7002 });
    expect(identifySession).not.toHaveBeenCalled();
  });

  it('says the app service is off for a launch link, without saving', async () => {
    const attempt = connect(`ltgopenlmsapp://token=${TOKEN}`, { file, fetch: restFetch('off') });
    await expect(attempt).rejects.toThrow(/turned off the app service/);
    expect(await readCredentialFile(file)).toBeNull();
  });

  it('reports an ended session, and reads 32 hex characters as a token when they are no cookie', async () => {
    identifySession.mockRejectedValue(new NeedsReconnect('The Moodle session has ended.'));
    await expect(connect(SESSION, { file, fetch: restFetch('off') })).rejects.toThrow(InvalidInput);
    await expect(connect(TOKEN, { file, fetch: restFetch('off') })).rejects.toThrow(/session has ended/);
    await connect(TOKEN, { file, fetch: restFetch(7001) });
    expect(await readCredentialFile(file)).toEqual({ token: TOKEN, moodleUserId: 7001 });
  });
});
