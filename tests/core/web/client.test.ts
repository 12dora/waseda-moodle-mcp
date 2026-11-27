import { describe, expect, it, vi } from 'vitest';
import { InvocationBudget } from '../../../src/core/budget';
import { BudgetExceeded, InvalidInput, MoodleError, MoodleUnavailable, NeedsReconnect } from '../../../src/core/errors';
import { AJAX_FUNCTIONS } from '../../../src/core/moodle/web/ajax-functions';
import { WebMoodleClient, type WebMoodleClientOptions } from '../../../src/core/moodle/web/client';
import type { WebSession } from '../../../src/core/moodle/web/types';

const adapter = vi.hoisted(() =>
  vi.fn(async (web: WebSession, params: Record<string, unknown>, hint: { cmid?: number }) => {
    const page = await web.page(`/mod/assign/view.php?id=${hint.cmid ?? 0}`);
    return { assignments: [{ cmid: hint.cmid, html: page.html, params }] };
  }),
);
const writer = vi.hoisted(() => vi.fn(async () => ({ status: true })));

vi.mock('../../../src/core/moodle/web/functions', () => ({
  WEB_FUNCTIONS: { mod_assign_get_assignments: adapter, mod_assign_save_submission: writer },
}));

const BASE = 'https://wsdmoodle.waseda.jp';
const COOKIE = 'MoodleSession=abcdefghij0123456789xyz';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

function setup(handler: Handler, extra: Partial<WebMoodleClientOptions> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(String(input)), init ?? {}),
  );
  const onSuccess = vi.fn();
  const client = new WebMoodleClient({
    session: { cookie: COOKIE, sesskey: 'Key0000001', baseUrl: BASE, fetch: fetchMock as unknown as typeof fetch },
    moodleUserId: 7001,
    onSuccess,
    ...extra,
  });
  return { client, fetchMock, onSuccess };
}

const ajaxOk: Handler = (url, init) =>
  url.pathname === '/lib/ajax/service.php'
    ? json((JSON.parse(String(init.body)) as Array<{ methodname: string }>).map((e) => ({ error: false, data: e })))
    : new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } });

describe('WebMoodleClient.call', () => {
  it('channel web; ajax functions go to service.php (one tick = one POST)', async () => {
    const { client, fetchMock, onSuccess } = setup(ajaxOk);
    expect(client.channel).toBe('web');
    expect(client.baseUrl).toBe(BASE);
    const [a, b] = await Promise.all([
      client.call('core_session_touch'),
      client.call('core_course_get_recent_courses', { userid: 7001 }),
    ]);
    expect(a).toMatchObject({ methodname: 'core_session_touch' });
    expect(b).toMatchObject({ methodname: 'core_course_get_recent_courses', args: { userid: 7001 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.callsMade).toBe(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('other functions go to their adapter with the session and the hint', async () => {
    const { client, fetchMock } = setup(ajaxOk);
    const out = await client.call('mod_assign_get_assignments', { courseids: [99101] }, { cmid: 7001 });
    expect(out).toEqual({ assignments: [{ cmid: 7001, html: '<p>page</p>', params: { courseids: [99101] } }] });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}/mod/assign/view.php?id=7001`);
    await client.call('mod_assign_get_assignments', { courseids: [99101] });
    expect(adapter.mock.calls.at(-1)?.[2]).toEqual({});
  });

  it('unsupported functions -> MoodleError servicenotavailable without a request', async () => {
    const { client, fetchMock } = setup(ajaxOk);
    const e = await client.call('core_enrol_get_users_courses', { userid: 7001 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MoodleError);
    expect((e as MoodleError).errorcode).toBe('servicenotavailable');
    expect((e as MoodleError).message).toBe('This needs the Moodle app service, which Waseda Moodle has turned off.');
    await expect(client.call('constructor')).rejects.toMatchObject({ errorcode: 'servicenotavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('memoises reads by fn + params + hint; writes clear the memo and the page memo', async () => {
    adapter.mockClear();
    const { client, fetchMock } = setup(ajaxOk);
    await client.call('mod_assign_get_assignments', { courseids: [1] }, { cmid: 7001 });
    await client.call('mod_assign_get_assignments', { courseids: [1] }, { cmid: 7001 });
    expect(adapter).toHaveBeenCalledTimes(1);
    await client.call('mod_assign_get_assignments', { courseids: [1] }, { cmid: 7002 });
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await client.call('mod_assign_save_submission', { assignmentid: 7001 });
    await client.call('mod_assign_get_assignments', { courseids: [1] }, { cmid: 7001 });
    expect(adapter).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(3); // the page memo was dropped too
  });

  it('core_files_get_unused_draft_itemid: a random id without a request', async () => {
    const { client, fetchMock } = setup(ajaxOk);
    const a = await client.call<{ itemid: number; warnings: unknown[] }>('core_files_get_unused_draft_itemid');
    const b = await client.call<{ itemid: number }>('core_files_get_unused_draft_itemid');
    expect(a.warnings).toEqual([]);
    for (const id of [a.itemid, b.itemid]) {
      expect(Number.isSafeInteger(id) && id >= 1 && id <= 999_999_999).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('charges the call budget and the invocation budget', async () => {
    const budget = new InvocationBudget(1, 10);
    const { client } = setup(ajaxOk, { budget, maxCalls: 5 });
    await client.call('core_session_touch');
    await expect(client.call('core_session_time_remaining')).rejects.toBeInstanceOf(BudgetExceeded);
    const small = setup(ajaxOk, { maxCalls: 1 });
    await small.client.call('core_session_touch');
    await expect(small.client.call('core_session_time_remaining')).rejects.toBeInstanceOf(BudgetExceeded);
  });
});

describe('WebMoodleClient.fetchFile', () => {
  const file = (body = 'PDF', headers: Record<string, string> = {}) =>
    new Response(body, {
      headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="a.pdf"', ...headers },
    });

  it('rewrites webservice URLs, drops the token, sends the cookie and passes Range/HEAD', async () => {
    const { client, fetchMock } = setup(() => file());
    const wsUrl = `${BASE}/webservice/pluginfile.php/501/mod_resource/content/1/a.pdf?token=abc&forcedownload=1`;
    const res = await client.fetchFile(wsUrl, { method: 'HEAD', range: 'bytes=0-9' });
    expect(await res.text()).toBe('PDF');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/pluginfile.php/501/mod_resource/content/1/a.pdf?forcedownload=1`);
    expect(init.method).toBe('HEAD');
    const headers = init.headers as Record<string, string>;
    expect(headers.Range).toBe('bytes=0-9');
    expect(headers.Cookie).toBe(COOKIE);
  });

  it('refuses other hosts and non-file paths', async () => {
    const { client, fetchMock } = setup(() => file());
    const evil = 'https://evil.example.com/pluginfile.php/1/a.pdf';
    await expect(client.fetchFile(evil)).rejects.toBeInstanceOf(InvalidInput);
    await expect(client.fetchFile(`${BASE}/mod/resource/view.php?id=1`)).rejects.toBeInstanceOf(InvalidInput);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows same-origin redirects (at most 3); never to another origin', async () => {
    let n = 0;
    const { client } = setup(() =>
      n++ < 2 ? new Response(null, { status: 303, headers: { Location: `/pluginfile.php/501/x/${n}.pdf` } }) : file(),
    );
    await expect(client.fetchFile('/pluginfile.php/501/x/0.pdf')).resolves.toBeInstanceOf(Response);
    const cdn = { status: 302, headers: { Location: 'https://cdn.example.com/a.pdf' } };
    const away = setup(() => new Response(null, cdn));
    await expect(away.client.fetchFile('/pluginfile.php/501/x/0.pdf')).rejects.toBeInstanceOf(MoodleUnavailable);
    expect(away.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a redirect to the login page -> NeedsReconnect', async () => {
    const login = { status: 303, headers: { Location: `${BASE}/login/index.php` } };
    const { client } = setup(() => new Response(null, login));
    await expect(client.fetchFile('/pluginfile.php/501/x/a.pdf')).rejects.toBeInstanceOf(NeedsReconnect);
  });

  it('403 / 404 come back as Responses (as on ws); an HTML error page instead of the file reads as a 404', async () => {
    const page = setup(() => new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }));
    const gone = await page.client.fetchFile('/pluginfile.php/501/x/a.pdf');
    expect(gone.status).toBe(404);
    const head = await page.client.fetchFile('/pluginfile.php/501/x/a.pdf', { method: 'HEAD' });
    expect(head.status).toBe(404);
    for (const status of [403, 404]) {
      const refused = setup(
        () => new Response('<html>no</html>', { status, headers: { 'content-type': 'text/html' } }),
      );
      expect((await refused.client.fetchFile('/pluginfile.php/501/x/a.pdf')).status).toBe(status);
    }
    const htmlFile = setup(() => file('<p>a stored page</p>', { 'content-type': 'text/html' }));
    await expect(htmlFile.client.fetchFile('/pluginfile.php/501/x/a.html')).resolves.toBeInstanceOf(Response);
  });

  it('the login page instead of the file -> NeedsReconnect', async () => {
    const login = '<html><body id="page-login-index" class="x"></body></html>';
    const { client } = setup(() => new Response(login, { headers: { 'content-type': 'text/html' } }));
    await expect(client.fetchFile('/pluginfile.php/501/x/a.pdf')).rejects.toBeInstanceOf(NeedsReconnect);
  });

  it("reads the user's own draft files with the session", async () => {
    const { client, fetchMock } = setup(() => file());
    await client.fetchFile(`${BASE}/draftfile.php/99500/user/draft/555012/minutes.pdf`);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}/draftfile.php/99500/user/draft/555012/minutes.pdf`);
  });

  it('keeps a rotated cookie only from the file itself, not from an error page', async () => {
    const rotated = (type: string) => () =>
      new Response('x', {
        headers: [
          ['content-type', type],
          ['Set-Cookie', 'MoodleSession=rotated0123456789abcdef; path=/'],
        ],
      });
    const withUpdate = (handler: Handler) => {
      const onUpdate = vi.fn();
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        handler(new URL(String(input)), init ?? {}),
      );
      const session = { cookie: COOKIE, baseUrl: BASE, fetch: fetchMock as unknown as typeof fetch, onUpdate };
      return { client: setup(handler, { session }).client, onUpdate };
    };
    const page = withUpdate(rotated('text/html'));
    await page.client.fetchFile('/pluginfile.php/501/x/a.pdf');
    expect(page.onUpdate).not.toHaveBeenCalled();
    const pdf = withUpdate(rotated('application/pdf'));
    await pdf.client.fetchFile('/pluginfile.php/501/x/a.pdf');
    expect(pdf.onUpdate).toHaveBeenCalledWith({ cookie: 'MoodleSession=rotated0123456789abcdef' });
  });
});

describe('WebMoodleClient.writesSent', () => {
  it('counts write calls and the session POSTs; reads count nothing', async () => {
    const { client } = setup(ajaxOk);
    expect(client.writesSent).toBe(0);
    await client.call('core_course_get_recent_courses');
    await client.call('mod_assign_get_assignments', {}, { cmid: 7001 });
    expect(client.writesSent).toBe(0);
    await client.call('mod_assign_save_submission', { assignmentid: 1 });
    expect(client.writesSent).toBe(1);
    await client.call('core_message_send_instant_messages', { messages: [] });
    expect(client.writesSent).toBe(3); // the write call and its ajax POST
  });
});

describe('WebMoodleClient.uploadToDraft', () => {
  it('needs the activity (hint.cmid)', async () => {
    const { client, fetchMock } = setup(ajaxOk);
    const f = { name: 'a.txt', body: new Uint8Array([1]), size: 1 };
    await expect(client.uploadToDraft(f, 0)).rejects.toThrow('The activity for this upload is unknown.');
    await expect(client.uploadToDraft(f, 0, {})).rejects.toBeInstanceOf(InvalidInput);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('web function tables', () => {
  it('adapters never shadow an ajax function', async () => {
    const real = await vi.importActual<typeof import('../../../src/core/moodle/web/functions')>(
      '../../../src/core/moodle/web/functions',
    );
    const shadowed = Object.keys(real.WEB_FUNCTIONS).filter((fn) => AJAX_FUNCTIONS.has(fn));
    expect(shadowed).toEqual([]);
    expect(AJAX_FUNCTIONS.has('core_files_get_unused_draft_itemid')).toBe(false);
  });
});
