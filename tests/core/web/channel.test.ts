import { describe, expect, it, vi } from 'vitest';
import { MoodleError, NeedsReconnect } from '../../../src/core/errors';
import { type ChannelClientOptions, createChannelClient } from '../../../src/core/moodle/web/channel';
import { mobileServiceEnabled } from '../../../src/core/moodle/web/public-config';

vi.mock('../../../src/core/moodle/web/functions', () => ({ WEB_FUNCTIONS: {} }));

const BASE = 'https://wsdmoodle.waseda.jp';
const TOKEN = '0123456789abcdef0123456789abcdef';
const OFF_MSG =
  'Waseda Moodle turned off the app service. Reconnect with the browser extension or the Moodle session cookie.';

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
const accessException = { exception: 'webservice_access_exception', errorcode: 'accessexception', message: 'Access' };
const serviceOff = { exception: 'moodle_exception', errorcode: 'servicenotavailable', message: 'Off' };
const invalidToken = { exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' };

type WsAnswer = () => unknown;

interface SetupOptions {
  ws?: WsAnswer[];
  /** The answer of /webservice/pluginfile.php (default: the file). */
  wsFile?: () => Response;
  token?: boolean;
  session?: boolean;
  mobileService?: boolean;
}

function setup(opts: SetupOptions) {
  const wsAnswers = [...(opts.ws ?? [])];
  const log: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/webservice/rest/server.php') {
      const fn = new URLSearchParams(String(init?.body)).get('wsfunction');
      log.push(`ws ${fn}`);
      return json((wsAnswers.shift() ?? (() => ({ ok: 'ws' })))());
    }
    if (url.pathname === '/lib/ajax/service.php') {
      const calls = JSON.parse(String(init?.body)) as Array<{ methodname: string }>;
      for (const c of calls) log.push(`web ${c.methodname}`);
      return json(calls.map(() => ({ error: false, data: { ok: 'web' } })));
    }
    log.push(`file ${url.pathname}`);
    if (opts.wsFile && url.pathname.startsWith('/webservice/')) return opts.wsFile();
    return new Response('bytes', { headers: { 'content-disposition': 'inline' } });
  });
  const doFetch = fetchMock as unknown as typeof fetch;
  const onMobileServiceOff = vi.fn(async () => {});
  const onTokenInvalid = vi.fn(async () => {});
  const token = { token: TOKEN, moodleUserId: 7001, baseUrl: BASE, fetch: doFetch, onTokenInvalid };
  const cookie = 'MoodleSession=abcdefghij0123456789xyz';
  const session = { session: { cookie, sesskey: 'Key0000001', baseUrl: BASE, fetch: doFetch }, moodleUserId: 7001 };
  const options: ChannelClientOptions = {
    moodleUserId: 7001,
    mobileService: opts.mobileService ?? true,
    token: opts.token === false ? null : token,
    session: opts.session === false ? null : session,
    onMobileServiceOff,
  };
  return { client: createChannelClient(options), log, onMobileServiceOff, onTokenInvalid };
}

describe('createChannelClient', () => {
  it('token + mobile service on: ws; after a success a ws failure is just an error', async () => {
    const { client, log, onMobileServiceOff } = setup({ ws: [() => ({ ok: 'ws' }), () => accessException] });
    expect(client.channel).toBe('ws');
    await expect(client.call('core_session_touch')).resolves.toEqual({ ok: 'ws' });
    await expect(client.call('core_session_touch', { a: 1 })).rejects.toMatchObject({ errorcode: 'accessexception' });
    expect(client.channel).toBe('ws');
    expect(log).toEqual(['ws core_session_touch', 'ws core_session_touch']);
    expect(onMobileServiceOff).not.toHaveBeenCalled();
    expect(client.callsMade).toBe(2);
  });

  it.each([
    ['accessexception', accessException],
    ['servicenotavailable', serviceOff],
  ])('first call answers %s: flips the site flag and repeats it on web', async (_n, answer) => {
    const { client, log, onMobileServiceOff } = setup({ ws: [() => answer] });
    await expect(client.call('core_session_touch')).resolves.toEqual({ ok: 'web' });
    expect(client.channel).toBe('web');
    expect(onMobileServiceOff).toHaveBeenCalledTimes(1);
    await client.call('core_session_time_remaining');
    expect(log).toEqual(['ws core_session_touch', 'web core_session_touch', 'web core_session_time_remaining']);
    expect(client.callsMade).toBe(3);
  });

  it('first call: dead token and a session -> web, the site flag stays', async () => {
    const { client, log, onMobileServiceOff, onTokenInvalid } = setup({ ws: [() => invalidToken] });
    await expect(client.call('core_session_touch')).resolves.toEqual({ ok: 'web' });
    expect(client.channel).toBe('web');
    expect(onMobileServiceOff).not.toHaveBeenCalled();
    expect(onTokenInvalid).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['ws core_session_touch', 'web core_session_touch']);
  });

  it('first call: service off and no session -> NeedsReconnect with the reconnect wording', async () => {
    const { client } = setup({ ws: [() => accessException], session: false });
    const e = await client.call('core_session_touch').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NeedsReconnect);
    expect((e as Error).message).toBe(OFF_MSG);
  });

  it('first call: dead token and no session -> the token NeedsReconnect', async () => {
    const { client } = setup({ ws: [() => invalidToken], session: false });
    await expect(client.call('core_session_touch')).rejects.toBeInstanceOf(NeedsReconnect);
  });

  it('an ordinary Moodle error on the first call settles ws', async () => {
    const other = { exception: 'invalid_parameter_exception', errorcode: 'invalidparameter', message: 'Bad' };
    const { client, log } = setup({ ws: [() => other, () => accessException] });
    await expect(client.call('core_session_touch')).rejects.toBeInstanceOf(MoodleError);
    await expect(client.call('core_session_touch')).rejects.toMatchObject({ errorcode: 'accessexception' });
    expect(log).toEqual(['ws core_session_touch', 'ws core_session_touch']);
  });

  it('concurrent calls wait for the first one to settle the channel', async () => {
    const { client, log } = setup({ ws: [() => serviceOff] });
    const out = await Promise.all([client.call('core_session_touch'), client.call('core_session_time_remaining')]);
    expect(out).toEqual([{ ok: 'web' }, { ok: 'web' }]);
    expect(log.filter((l) => l.startsWith('ws'))).toEqual(['ws core_session_touch']);
  });

  it.each([
    ['the mobile service is off', { mobileService: false }],
    ['there is no token', { token: false }],
  ])('web straight away when %s', async (_n, opts) => {
    const { client, log } = setup(opts);
    expect(client.channel).toBe('web');
    await client.call('core_session_touch');
    expect(log).toEqual(['web core_session_touch']);
  });

  it('web needed but no session -> NeedsReconnect', async () => {
    const off = setup({ mobileService: false, session: false });
    await expect(off.client.call('core_session_touch')).rejects.toThrow(OFF_MSG);
    const none = setup({ token: false, session: false });
    await expect(none.client.call('core_session_touch')).rejects.toBeInstanceOf(NeedsReconnect);
  });

  it('a first file download settles the channel like a call: service off -> the file from web', async () => {
    const { client, log, onMobileServiceOff } = setup({ wsFile: () => json(serviceOff) });
    const res = await client.fetchFile(`${BASE}/pluginfile.php/501/x/a.pdf`);
    expect(await res.text()).toBe('bytes');
    expect(client.channel).toBe('web');
    expect(onMobileServiceOff).toHaveBeenCalledTimes(1);
    await client.call('core_session_touch');
    expect(log).toEqual([
      'file /webservice/pluginfile.php/501/x/a.pdf',
      'file /pluginfile.php/501/x/a.pdf',
      'web core_session_touch',
    ]);
  });

  it('a first file download that works settles ws: a later service-off answer does not switch mid-request', async () => {
    const { client, log } = setup({ ws: [() => accessException] });
    await client.fetchFile(`${BASE}/pluginfile.php/501/x/a.pdf`);
    expect(client.channel).toBe('ws');
    await expect(client.call('core_session_touch')).rejects.toMatchObject({ errorcode: 'accessexception' });
    expect(log).toEqual(['file /webservice/pluginfile.php/501/x/a.pdf', 'ws core_session_touch']);
  });

  it('a streamed upload settles the channel with a read first: the stream is never spent on ws', async () => {
    const { client, log } = setup({ ws: [() => serviceOff] });
    const body = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    await expect(client.uploadToDraft({ name: 'a.txt', body, size: 0 }, 0)).rejects.toThrow(
      'The activity for this upload is unknown.',
    );
    expect(client.channel).toBe('web');
    expect(body.locked).toBe(false);
    expect(log).toEqual(['ws core_course_get_recent_courses', 'web core_course_get_recent_courses']);
  });

  it('writesSent adds up both channels', async () => {
    const { client } = setup({ ws: [() => serviceOff] });
    expect(client.writesSent).toBe(0);
    await client.call('core_message_send_instant_messages', { messages: [] });
    expect(client.channel).toBe('web');
    expect(client.writesSent).toBe(3); // the refused ws write (Moodle answered), the web write call and its POST
  });
});

describe('mobileServiceEnabled', () => {
  const answer = (flag: number) => async () => json([{ error: false, data: { enablemobilewebservice: flag } }]);

  it('POSTs tool_mobile_get_public_config to service-nologin.php and reads the flag', async () => {
    const fetchMock = vi.fn(answer(0));
    await expect(mobileServiceEnabled(fetchMock as unknown as typeof fetch, BASE)).resolves.toBe(false);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config`);
    expect(JSON.parse(String(init.body))).toEqual([
      { index: 0, methodname: 'tool_mobile_get_public_config', args: {} },
    ]);
    await expect(mobileServiceEnabled(vi.fn(answer(1)) as unknown as typeof fetch, BASE)).resolves.toBe(true);
  });

  it('null when Moodle cannot be asked', async () => {
    const down = vi.fn(async () => new Response('busy', { status: 503 }));
    await expect(mobileServiceEnabled(down as unknown as typeof fetch, BASE)).resolves.toBeNull();
    const broken = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(mobileServiceEnabled(broken as unknown as typeof fetch, BASE)).resolves.toBeNull();
    const refused = vi.fn(async () => json([{ error: true, exception: { errorcode: 'x' } }]));
    await expect(mobileServiceEnabled(refused as unknown as typeof fetch, BASE)).resolves.toBeNull();
  });
});
