import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeedsReconnect } from '../../src/core/errors';
import { type Credential, readCredentialFile, writeCredential } from '../../src/node/credential-file';
import { LiveConnection } from '../../src/node/live-connection';

interface FakeSessionOptions {
  cookie: string;
  sesskey?: string | null;
  onUpdate?: (update: { cookie?: string; sesskey?: string }) => void | Promise<void>;
  onEnded?: () => void | Promise<void>;
}

const { identifySession, mobileServiceEnabled, ajax } = vi.hoisted(() => ({
  identifySession: vi.fn(),
  mobileServiceEnabled: vi.fn(),
  ajax: vi.fn<(options: unknown, fn: string) => Promise<unknown>>(),
}));
vi.mock('../../src/core/moodle/web/identify', async (original) => ({
  ...(await original<typeof import('../../src/core/moodle/web/identify')>()),
  identifySession,
}));
vi.mock('../../src/core/moodle/web/public-config', () => ({ mobileServiceEnabled }));
vi.mock('../../src/core/moodle/web/session', () => ({
  MoodleWebSession: class {
    constructor(private readonly options: unknown) {}
    ajax(fn: string) {
      return ajax(this.options, fn);
    }
  },
}));

const TOKEN = '0123456789abcdef0123456789abcdef';
const SESSION = 'MoodleSession=abcdefghij0123456789klmnop';
const NEXT = 'MoodleSession=zyxwvutsrq9876543210ponmlk';
const HOUR = 3_600_000;

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wmm-live-'));
  file = join(dir, 'token');
  identifySession.mockReset();
  identifySession.mockResolvedValue({
    moodleUserId: 7001,
    fullname: 'Taro Yamada',
    lang: null,
    sesskey: 'KeyKey1234',
    cookie: SESSION,
  });
  mobileServiceEnabled.mockReset().mockResolvedValue(false);
  ajax.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(credential: Credential, opts: { fromEnv?: boolean; fetch?: typeof fetch } = {}) {
  if (!opts.fromEnv) await writeCredential(file, credential);
  const timers: Array<{ ms: number; task: () => Promise<void>; stopped: boolean }> = [];
  const log = vi.fn<(message: string) => void>();
  const onChange = vi.fn();
  const connection = new LiveConnection({
    credential,
    file: opts.fromEnv ? null : file,
    fetch: opts.fetch ?? (vi.fn() as unknown as typeof fetch),
    log,
    onChange,
    every: (ms, task) => {
      const timer = { ms, task, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
  });
  const timer = (ms: number) => {
    const found = timers.find((t) => t.ms === ms);
    if (!found) throw new Error(`no timer of ${ms} ms`);
    return found;
  };
  const logged = () => log.mock.calls.map(([m]) => m).join('\n');
  return { connection, timers, timer, log, logged, onChange };
}

const webOptions = (connection: LiveConnection) => {
  const options = connection.clientOptions().session?.session;
  if (!options) throw new Error('no web session');
  return options as FakeSessionOptions;
};

describe('LiveConnection', () => {
  const saved = { session: SESSION, moodleUserId: 7001 };

  it('identifies a session, stores its sesskey and builds clients with 200 calls each', async () => {
    const { connection, timers } = await setup(saved);
    expect(await connection.start()).toEqual({ moodleUserId: 7001, fullname: 'Taro Yamada', lang: 'en' });
    await connection.flush();
    expect(await readCredentialFile(file)).toEqual({ ...saved, sesskey: 'KeyKey1234' });
    expect(timers.map((t) => t.ms)).toEqual([HOUR]); // no token: no app service check
    expect(mobileServiceEnabled).not.toHaveBeenCalled();
    const options = connection.clientOptions();
    expect(options).toMatchObject({ moodleUserId: 7001, token: null });
    expect(options.session).toMatchObject({ moodleUserId: 7001, maxCalls: 200 });
    expect(webOptions(connection)).toMatchObject({ cookie: SESSION, sesskey: 'KeyKey1234' });
  });

  it('checks the app service at the start and every 6 h, keeping the last answer when unreachable', async () => {
    const { connection, timer, onChange } = await setup({ ...saved, token: TOKEN });
    await connection.start();
    expect(connection.clientOptions().mobileService).toBe(false);
    expect(connection.clientOptions().token).toMatchObject({ token: TOKEN, moodleUserId: 7001, maxCalls: 200 });
    onChange.mockClear();
    mobileServiceEnabled.mockResolvedValue(null);
    await timer(6 * HOUR).task();
    expect(connection.clientOptions().mobileService).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    mobileServiceEnabled.mockResolvedValue(true);
    await timer(6 * HOUR).task();
    expect(connection.clientOptions().mobileService).toBe(true);
    await connection.clientOptions().onMobileServiceOff?.();
    expect(connection.clientOptions().mobileService).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    await connection.flush();
  });

  it('writes a rotated cookie back and ignores updates of an outdated session object', async () => {
    const { connection, onChange } = await setup(saved);
    await connection.start();
    const first = webOptions(connection);
    const stale = webOptions(connection);
    await first.onUpdate?.({ cookie: NEXT });
    await first.onUpdate?.({ sesskey: 'NewKey5678' });
    await stale.onUpdate?.({ sesskey: 'OldKey0000' });
    await stale.onEnded?.();
    await connection.flush();
    expect(await readCredentialFile(file)).toEqual({ ...saved, session: NEXT, sesskey: 'NewKey5678' });
    expect(webOptions(connection).cookie).toBe(NEXT);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never overwrites a newer connect', async () => {
    const { connection } = await setup(saved);
    await connection.start();
    await connection.flush();
    await writeCredential(file, { session: NEXT, moodleUserId: 7001 });
    await webOptions(connection).onEnded?.();
    await connection.flush();
    expect(await readCredentialFile(file)).toEqual({ session: NEXT, moodleUserId: 7001 });
  });

  it('touches the session hourly and stops when it ended, telling the user to connect again', async () => {
    const { connection, timer, logged } = await setup(saved);
    await connection.start();
    await timer(HOUR).task();
    expect(ajax).toHaveBeenLastCalledWith(expect.objectContaining({ cookie: SESSION }), 'core_session_touch');

    ajax.mockRejectedValueOnce(new Error('offline'));
    await timer(HOUR).task();
    expect(logged()).toContain('trying again');
    expect(timer(HOUR).stopped).toBe(false);

    ajax.mockImplementationOnce(async (options) => {
      await (options as FakeSessionOptions).onEnded?.();
      throw new NeedsReconnect();
    });
    await timer(HOUR).task();
    await connection.flush();
    expect(timer(HOUR).stopped).toBe(true);
    expect(logged()).toContain('waseda-moodle-mcp connect');
    expect(connection.clientOptions().session).toBeNull();
    expect(await readCredentialFile(file)).toEqual({ moodleUserId: 7001 });
  });

  it('fails the start when the only session has ended, after forgetting it', async () => {
    identifySession.mockRejectedValue(new NeedsReconnect());
    const { connection, timers } = await setup(saved);
    await expect(connection.start()).rejects.toThrow(NeedsReconnect);
    expect(timers).toEqual([]);
    expect(await readCredentialFile(file)).toEqual({ moodleUserId: 7001 });
  });

  it('falls back to the token, and drops a token Moodle rejects', async () => {
    identifySession.mockRejectedValue(new NeedsReconnect());
    mobileServiceEnabled.mockResolvedValue(true);
    const info = { siteurl: 'https://wsdmoodle.waseda.jp', userid: 7001, fullname: 'Taro Yamada', lang: 'ja' };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(info))) as unknown as typeof fetch;
    const { connection, timers, logged } = await setup({ ...saved, token: TOKEN }, { fetch: fetchImpl });
    expect(await connection.start()).toMatchObject({ moodleUserId: 7001, lang: 'ja' });
    expect(timers.map((t) => t.ms)).toEqual([6 * HOUR]);
    await connection.clientOptions().token?.onTokenInvalid?.(TOKEN);
    expect(connection.clientOptions().token).toBeNull();
    expect(logged()).toContain('waseda-moodle-mcp connect');
  });

  it('keeps a credential from the environment in memory only', async () => {
    const { connection, logged } = await setup({ session: SESSION }, { fromEnv: true });
    await connection.start();
    await webOptions(connection).onUpdate?.({ cookie: NEXT });
    await connection.flush();
    expect(webOptions(connection).cookie).toBe(NEXT);
    expect(logged()).toContain('WMM_SESSION');
    expect(await readCredentialFile(file)).toBeNull();
  });

  it('stops its timers', async () => {
    const { connection, timers } = await setup({ ...saved, token: TOKEN });
    await connection.start();
    connection.stop();
    expect(timers.map((t) => t.stopped)).toEqual([true, true]);
    await connection.flush();
  });
});
