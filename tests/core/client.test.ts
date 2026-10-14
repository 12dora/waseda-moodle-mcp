import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceeded, InvalidInput, MoodleError, MoodleUnavailable, NeedsReconnect } from '../../src/core/errors';
import { encodeParams, MoodleClient } from '../../src/core/moodle/client';

const TOKEN = '0123456789abcdef0123456789abcdef';
const BASE = 'https://moodle.example.test';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

function setup(handler: Handler, extra: Partial<ConstructorParameters<typeof MoodleClient>[0]> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {}));
  const client = new MoodleClient({
    token: TOKEN,
    moodleUserId: 1001,
    baseUrl: BASE,
    fetch: fetchMock as unknown as typeof fetch,
    ...extra,
  });
  return { client, fetchMock };
}
const bodyOf = (init: RequestInit) => new URLSearchParams(String(init.body));

afterEach(() => vi.unstubAllGlobals());

describe('encodeParams', () => {
  it('uses PHP array encoding and 0/1 booleans, skipping null/undefined', () => {
    const p = encodeParams({
      a: 1,
      b: true,
      c: false,
      d: 'x y',
      e: [3, 7],
      f: { g: { h: 'z' } },
      opts: [{ name: 'cmid', value: 5 }],
      skip: undefined,
      nul: null,
    });
    expect(Object.fromEntries(p)).toEqual({
      a: '1',
      b: '1',
      c: '0',
      d: 'x y',
      'e[0]': '3',
      'e[1]': '7',
      'f[g][h]': 'z',
      'opts[0][name]': 'cmid',
      'opts[0][value]': '5',
    });
  });
});

describe('MoodleClient.call', () => {
  it('POSTs a form body with the token and returns the parsed JSON', async () => {
    const { client, fetchMock } = setup(() => json({ userid: 1001 }));
    const out = await client.call<{ userid: number }>('core_webservice_get_site_info', { courseids: [4, 5] });
    expect(out).toEqual({ userid: 1001 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/webservice/rest/server.php`);
    expect(init!.method).toBe('POST');
    const body = bodyOf(init!);
    expect(body.get('wstoken')).toBe(TOKEN);
    expect(body.get('wsfunction')).toBe('core_webservice_get_site_info');
    expect(body.get('moodlewsrestformat')).toBe('json');
    expect(body.get('courseids[1]')).toBe('5');
    expect(client.callsMade).toBe(1);
  });

  it('memoises reads but never writes', async () => {
    const { client, fetchMock } = setup(() => json([]));
    await client.call('core_course_get_contents', { courseid: 1 });
    await client.call('core_course_get_contents', { courseid: 1 });
    await client.call('core_course_get_contents', { courseid: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await client.call('mod_assign_save_submission', { assignmentid: 1 });
    await client.call('mod_assign_save_submission', { assignmentid: 1 });
    await client.call('core_files_get_unused_draft_itemid');
    await client.call('core_files_get_unused_draft_itemid');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('shares one request between concurrent identical reads', async () => {
    const { client, fetchMock } = setup(() => json({ ok: 1 }));
    await Promise.all([client.call('core_x_get_a', { id: 1 }), client.call('core_x_get_a', { id: 1 })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not memoise failures', async () => {
    let n = 0;
    const { client } = setup(() =>
      n++ === 0 ? json({ exception: 'moodle_exception', errorcode: 'x', message: 'no' }) : json({ ok: 1 }),
    );
    await expect(client.call('core_x_get_a')).rejects.toBeInstanceOf(MoodleError);
    await expect(client.call('core_x_get_a')).resolves.toEqual({ ok: 1 });
  });

  it('maps a Moodle error object to MoodleError', async () => {
    const { client } = setup(() =>
      json({
        exception: 'required_capability_exception',
        errorcode: 'nopermission',
        message: 'Denied',
        debuginfo: 'secret',
      }),
    );
    const err = (await client.call('core_x_get_a').catch((e: unknown) => e)) as MoodleError;
    expect(err).toBeInstanceOf(MoodleError);
    expect(err).toMatchObject({
      errorcode: 'nopermission',
      exception: 'required_capability_exception',
      message: 'Denied',
    });
    expect(String(err.message)).not.toContain('secret');
  });

  it('invalidtoken -> onTokenInvalid once, NeedsReconnect, and no further network use', async () => {
    const onTokenInvalid = vi.fn(async () => {});
    const { client, fetchMock } = setup(
      () =>
        json({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token - token not found' }),
      { onTokenInvalid },
    );
    await expect(client.call('core_x_get_a')).rejects.toBeInstanceOf(NeedsReconnect);
    await expect(client.call('core_x_get_b')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(onTokenInvalid).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accessexception about an expired token -> NeedsReconnect; other accessexceptions stay MoodleError', async () => {
    const onTokenInvalid = vi.fn(async () => {});
    const expired = setup(
      () =>
        json({
          exception: 'webservice_access_exception',
          errorcode: 'accessexception',
          message: 'Access control exception',
          debuginfo: 'Invalid token - token expired',
        }),
      { onTokenInvalid },
    );
    await expect(expired.client.call('core_x_get_a')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(onTokenInvalid).toHaveBeenCalledTimes(1);

    const other = setup(
      () =>
        json({
          exception: 'webservice_access_exception',
          errorcode: 'accessexception',
          message: 'Access control exception',
          debuginfo: 'Access to the function core_x_get_a() is not allowed',
        }),
      { onTokenInvalid },
    );
    await expect(other.client.call('core_x_get_a')).rejects.toBeInstanceOf(MoodleError);
    expect(onTokenInvalid).toHaveBeenCalledTimes(1);
  });

  it('HTTP 5xx: reads retry once, writes do not', async () => {
    const read = setup(() => new Response('oops', { status: 503 }));
    await expect(read.client.call('core_x_get_a')).rejects.toBeInstanceOf(MoodleUnavailable);
    expect(read.fetchMock).toHaveBeenCalledTimes(2);
    expect(read.client.callsMade).toBe(2);

    const write = setup(() => new Response('oops', { status: 500 }));
    await expect(write.client.call('core_x_update_a')).rejects.toBeInstanceOf(MoodleUnavailable);
    expect(write.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a transient failure followed by success returns the data', async () => {
    let n = 0;
    const { client } = setup(() => (n++ === 0 ? new Response('x', { status: 502 }) : json({ ok: true })));
    await expect(client.call('core_x_get_a')).resolves.toEqual({ ok: true });
  });

  it('treats non-JSON bodies and network errors as MoodleUnavailable', async () => {
    const html = setup(() => new Response('<html>maintenance</html>', { status: 200 }));
    await expect(html.client.call('core_x_get_a')).rejects.toBeInstanceOf(MoodleUnavailable);
    const net = setup(() => {
      throw new TypeError('fetch failed');
    });
    await expect(net.client.call('core_x_get_a')).rejects.toBeInstanceOf(MoodleUnavailable);
  });

  it('times out slow calls', async () => {
    const { client } = setup(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal!.addEventListener('abort', () => rej(new Error('aborted')));
        }),
      { timeoutMs: 20 },
    );
    await expect(client.call('core_x_update_a')).rejects.toBeInstanceOf(MoodleUnavailable);
  });

  it('enforces the call budget (retries count)', async () => {
    const { client, fetchMock } = setup(() => json({ ok: 1 }), { maxCalls: 2 });
    await client.call('core_x_get_a', { i: 1 });
    await client.call('core_x_get_a', { i: 2 });
    await client.call('core_x_get_a', { i: 1 }); // memo hit: free
    await expect(client.call('core_x_get_a', { i: 3 })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('calls onSuccess once after the first good response', async () => {
    const onSuccess = vi.fn();
    const { client } = setup(() => json({ ok: 1 }), { onSuccess });
    await client.call('core_x_get_a', { i: 1 });
    await client.call('core_x_get_a', { i: 2 });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('never lets params override the reserved fields', async () => {
    const { client, fetchMock } = setup(() => json({ ok: 1 }));
    await client.call('core_x_get_a', { wstoken: 'evil', wsfunction: 'other', moodlewsrestformat: 'xml', id: 3 });
    const body = bodyOf(fetchMock.mock.calls[0]![1]!);
    expect(body.getAll('wstoken')).toEqual([TOKEN]);
    expect(body.getAll('wsfunction')).toEqual(['core_x_get_a']);
    expect(body.getAll('moodlewsrestformat')).toEqual(['json']);
    expect(body.get('id')).toBe('3');
  });

  it('does not follow redirects on REST calls (the token is in the body)', async () => {
    const { client, fetchMock } = setup(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } }),
    );
    await expect(client.call('core_x_update_a')).rejects.toBeInstanceOf(MoodleUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]!.redirect).toBe('manual');
  });

  it('forgets memoised reads after any write', async () => {
    const { client, fetchMock } = setup(() => json({ ok: 1 }));
    await client.call('core_x_get_a', { id: 1 });
    await client.call('core_x_get_a', { id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client.call('mod_x_update_a', { id: 1 });
    await client.call('core_x_get_a', { id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns JSON null for void functions', async () => {
    const { client } = setup(() => new Response('null', { status: 200 }));
    await expect(client.call('core_x_mark_a')).resolves.toBeNull();
  });
});

describe('MoodleClient.fetchFile', () => {
  const ok = () => new Response('data', { status: 200, headers: { 'content-type': 'application/pdf' } });

  it('appends the token to webservice/pluginfile URLs (with ? or &)', async () => {
    const { client, fetchMock } = setup(ok);
    await client.fetchFile(`${BASE}/webservice/pluginfile.php/12/mod_resource/content/1/a.pdf`);
    await client.fetchFile(`${BASE}/webservice/pluginfile.php/12/mod_resource/content/1/a.pdf?forcedownload=1`);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `${BASE}/webservice/pluginfile.php/12/mod_resource/content/1/a.pdf?token=${TOKEN}`,
    );
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      `${BASE}/webservice/pluginfile.php/12/mod_resource/content/1/a.pdf?forcedownload=1&token=${TOKEN}`,
    );
  });

  it('rewrites /pluginfile.php/ to the webservice endpoint and replaces a stale token', async () => {
    const { client, fetchMock } = setup(ok);
    await client.fetchFile(`${BASE}/pluginfile.php/12/mod_resource/content/1/a.pdf?token=stale`);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `${BASE}/webservice/pluginfile.php/12/mod_resource/content/1/a.pdf?token=${TOKEN}`,
    );
  });

  it('passes Range and method, and returns the unbuffered upstream response', async () => {
    const upstream = ok();
    const { client, fetchMock } = setup(() => upstream);
    const res = await client.fetchFile(`${BASE}/webservice/pluginfile.php/1/a/b/c.pdf`, {
      method: 'HEAD',
      range: 'bytes=0-9',
    });
    expect(res).toBe(upstream);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe('HEAD');
    expect(new Headers(init.headers).get('range')).toBe('bytes=0-9');
  });

  it('refuses other hosts and other paths without any request', async () => {
    const { client, fetchMock } = setup(ok);
    for (const bad of [
      'https://evil.example.test/webservice/pluginfile.php/1/a/b/c.pdf',
      `${BASE}/admin/tool/mobile/launch.php`,
      `${BASE}/webservice/pluginfile.php/../../user/profile.php`,
      `${BASE}.evil.example.test/pluginfile.php/1/a`,
      'http://moodle.example.test/pluginfile.php/1/a',
      'not a url at all %%',
    ]) {
      await expect(client.fetchFile(bad)).rejects.toBeInstanceOf(InvalidInput);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows same-host redirects but never leaves the host', async () => {
    let n = 0;
    const { client, fetchMock } = setup(() =>
      n++ === 0
        ? new Response(null, { status: 302, headers: { location: `${BASE}/pluginfile.php/1/a/b/moved.pdf` } })
        : ok(),
    );
    const res = await client.fetchFile(`${BASE}/webservice/pluginfile.php/1/a/b/c.pdf`);
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/webservice/pluginfile.php/1/a/b/moved.pdf?token=');

    const evil = setup(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/x' } }));
    await expect(evil.client.fetchFile(`${BASE}/webservice/pluginfile.php/1/a/b/c.pdf`)).rejects.toMatchObject({
      name: 'MoodleUnavailable',
      message: 'Moodle redirected the download unexpectedly.',
    });
    expect(evil.fetchMock).toHaveBeenCalledTimes(1);

    const wrongPath = setup(
      () => new Response(null, { status: 302, headers: { location: `${BASE}/user/profile.php` } }),
    );
    await expect(wrongPath.client.fetchFile(`${BASE}/webservice/pluginfile.php/1/a/b/c.pdf`)).rejects.toBeInstanceOf(
      MoodleUnavailable,
    );
    expect(wrongPath.fetchMock).toHaveBeenCalledTimes(1);
  });

  const FILE = `${BASE}/webservice/pluginfile.php/1/a/b/c.pdf`;
  const jsonRes = (v: unknown, withLength: boolean) => {
    const body = JSON.stringify(v);
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    if (withLength) headers['content-length'] = String(body.length);
    return new Response(body, { status: 200, headers });
  };

  it('maps a bad-token JSON answer (with or without Content-Length) to NeedsReconnect', async () => {
    for (const withLength of [true, false]) {
      const onTokenInvalid = vi.fn(async () => {});
      const bad = setup(
        () => jsonRes({ error: 'Invalid token - token not found', errorcode: 'invalidtoken' }, withLength),
        {
          onTokenInvalid,
        },
      );
      await expect(bad.client.fetchFile(FILE)).rejects.toBeInstanceOf(NeedsReconnect);
      expect(onTokenInvalid).toHaveBeenCalledTimes(1);
    }
  });

  it('maps other JSON error answers to MoodleError with the error text', async () => {
    const other = setup(() => jsonRes({ error: 'File not found', errorcode: 'filenotfound' }, false));
    await expect(other.client.fetchFile(FILE)).rejects.toMatchObject({
      name: 'MoodleError',
      errorcode: 'filenotfound',
      message: 'File not found',
    });
  });

  it('leaves ordinary JSON files readable by the caller', async () => {
    const { client } = setup(() => jsonRes({ hello: 'world' }, false));
    const res = await client.fetchFile(FILE);
    expect(await res.json()).toEqual({ hello: 'world' });
    const large = setup(() => jsonRes({ pad: 'x'.repeat(10_000) }, false));
    const big = await large.client.fetchFile(FILE);
    expect(((await big.json()) as { pad: string }).pad.length).toBe(10_000);
  });

  it('maps 5xx to MoodleUnavailable', async () => {
    const down = setup(() => new Response('x', { status: 503 }));
    await expect(down.client.fetchFile(FILE)).rejects.toBeInstanceOf(MoodleUnavailable);
  });
});

describe('MoodleClient.uploadToDraft', () => {
  const okRecord = [{ itemid: 555, filename: 'report.pdf', filesize: 11, filepath: '/' }];
  const text = (init: RequestInit) => new Response(init.body as BodyInit).text();

  it('sends a multipart body with token, itemid, filepath and the file (Uint8Array)', async () => {
    let seen = '';
    let headers: Headers | undefined;
    const { client, fetchMock } = setup(async (_u, init) => {
      seen = await text(init);
      headers = new Headers(init.headers);
      return json(okRecord);
    });
    const r = await client.uploadToDraft(
      { name: 'report.pdf', body: new TextEncoder().encode('hello world'), size: 11, mime: 'application/pdf' },
      0,
    );
    expect(r).toEqual({ itemid: 555, filename: 'report.pdf', filesize: 11 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/webservice/upload.php`);
    const boundary = /boundary=(.+)$/.exec(headers!.get('content-type')!)![1]!;
    expect(seen).toContain(`name="token"\r\n\r\n${TOKEN}\r\n`);
    expect(seen).toContain('name="itemid"\r\n\r\n0\r\n');
    expect(seen).toContain('name="filepath"\r\n\r\n/\r\n');
    expect(seen).toContain('filename="report.pdf"\r\nContent-Type: application/pdf\r\n\r\nhello world\r\n');
    expect(seen.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it('collects a stream into one body when FixedLengthStream is unavailable', async () => {
    vi.stubGlobal('FixedLengthStream', undefined);
    let seen = '';
    const { client } = setup(async (_u, init) => {
      seen = await text(init);
      expect(typeof init.body).not.toBe('undefined');
      return json(okRecord);
    });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('hello '));
        c.enqueue(new TextEncoder().encode('world'));
        c.close();
      },
    });
    await client.uploadToDraft({ name: 'a.txt', body, size: 11 }, 77);
    expect(seen).toContain('name="itemid"\r\n\r\n77\r\n');
    expect(seen).toContain('hello world\r\n');
    expect(seen).toContain('Content-Type: application/octet-stream');
  });

  it('streams through FixedLengthStream with the exact total length when available', async () => {
    let declared = -1;
    class FakeFixedLengthStream {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      constructor(n: number) {
        declared = n;
        const t = new TransformStream<Uint8Array, Uint8Array>();
        this.readable = t.readable;
        this.writable = t.writable;
      }
    }
    vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
    let seen = '';
    const { client } = setup(async (_u, init) => {
      expect((init as { duplex?: string }).duplex).toBe('half');
      seen = await text(init);
      return json(okRecord);
    });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('hello world'));
        c.close();
      },
    });
    await client.uploadToDraft({ name: 'a.txt', body, size: 11 }, 0);
    expect(declared).toBe(new TextEncoder().encode(seen).length);
    expect(seen).toContain('hello world');
  });

  it('maps upload errors', async () => {
    const dup = setup(() => json([{ filename: 'a.txt', errortype: 'filenameexist', error: 'File exists' }]));
    await expect(
      dup.client.uploadToDraft({ name: 'a.txt', body: new Uint8Array(1), size: 1 }, 5),
    ).rejects.toMatchObject({
      name: 'MoodleError',
      errorcode: 'filenameexist',
    });
    const big = setup(() => json({ error: 'File too large', errortype: 'fileoversized' }));
    await expect(
      big.client.uploadToDraft({ name: 'a.txt', body: new Uint8Array(1), size: 1 }, 5),
    ).rejects.toMatchObject({
      errorcode: 'fileoversized',
    });
    const tok = setup(() =>
      json({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' }),
    );
    await expect(
      tok.client.uploadToDraft({ name: 'a.txt', body: new Uint8Array(1), size: 1 }, 5),
    ).rejects.toBeInstanceOf(NeedsReconnect);
    const down = setup(() => new Response('bad gateway', { status: 502 }));
    await expect(
      down.client.uploadToDraft({ name: 'a.txt', body: new Uint8Array(1), size: 1 }, 5),
    ).rejects.toBeInstanceOf(MoodleUnavailable);
  });

  it('escapes quotes and line breaks in file names', async () => {
    let seen = '';
    const { client } = setup(async (_u, init) => {
      seen = await text(init);
      return json(okRecord);
    });
    await client.uploadToDraft({ name: 'we"ird\r\nna/me\\x.txt', body: new Uint8Array(1), size: 1 }, 0);
    expect(seen).toContain('filename="we_ird__na_me_x.txt"');
  });

  it('rejects invalid sizes and does not follow redirects', async () => {
    const { client, fetchMock } = setup(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } }),
    );
    for (const size of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(client.uploadToDraft({ name: 'a.txt', body: new Uint8Array(1), size }, 0)).rejects.toBeInstanceOf(
        InvalidInput,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(client.uploadToDraft({ name: 'a.txt', body: new Uint8Array(1), size: 1 }, 0)).rejects.toBeInstanceOf(
      MoodleUnavailable,
    );
    expect(fetchMock.mock.calls[0]![1]!.redirect).toBe('manual');
  });
});
