import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceeded, InvalidInput, MoodleError, MoodleUnavailable, NeedsReconnect } from '../../../src/core/errors';
import { MoodleWebSession, type MoodleWebSessionOptions } from '../../../src/core/moodle/web/session';

const BASE = 'https://wsdmoodle.waseda.jp';
const COOKIE = 'MoodleSession=abcdefghij0123456789xyz';
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/web/${name}`, import.meta.url), 'utf8');
const PROFILE = fixture('core-profile-ja.html');

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

const json = (v: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json', ...headers } });
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const redirect = (location: string, status = 303) => new Response(null, { status, headers: { Location: location } });
const ok = (data: unknown) => ({ error: false, data });

function setup(handler: Handler, extra: Partial<MoodleWebSessionOptions> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(String(input)), init ?? {}),
  );
  const charge = vi.fn();
  const onUpdate = vi.fn();
  const onEnded = vi.fn();
  const session = new MoodleWebSession({
    cookie: COOKIE,
    sesskey: 'Key0000001',
    moodleUserId: 7001,
    baseUrl: BASE,
    fetch: fetchMock as unknown as typeof fetch,
    charge,
    onUpdate,
    onEnded,
    ...extra,
  });
  return { session, fetchMock, charge, onUpdate, onEnded };
}

const requestsOf = (fetchMock: ReturnType<typeof setup>['fetchMock']) =>
  fetchMock.mock.calls.map(([u, init]) => ({ url: new URL(String(u)), init: init ?? {} }));
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Array<{ index: number; methodname: string }>;

/** An ajax handler answering each entry with `answer(methodname, args)`. */
const ajaxEcho =
  (answer: (fn: string, args: Record<string, unknown>) => unknown): Handler =>
  (_url, init) =>
    json(
      (JSON.parse(String(init.body)) as Array<{ methodname: string; args: Record<string, unknown> }>).map((e) =>
        answer(e.methodname, e.args),
      ),
    );

describe('MoodleWebSession.ajax', () => {
  it('sends one POST per tick with the sesskey and the cookie, answers in order', async () => {
    const { session, fetchMock, charge } = setup(ajaxEcho((fn, args) => ok({ fn, args })));
    const [a, b] = await Promise.all([
      session.ajax('core_session_touch'),
      session.ajax('core_course_get_module', { id: 7001 }),
    ]);
    expect(a).toEqual({ fn: 'core_session_touch', args: {} });
    expect(b).toEqual({ fn: 'core_course_get_module', args: { id: 7001 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledTimes(1);
    const [req] = requestsOf(fetchMock);
    expect(req?.url.pathname).toBe('/lib/ajax/service.php');
    expect(req?.url.searchParams.get('sesskey')).toBe('Key0000001');
    expect(req?.init.method).toBe('POST');
    expect((req?.init.headers as Record<string, string> | undefined)?.Cookie).toBe(COOKIE);
    expect(bodyOf(req?.init ?? {}).map((e) => [e.index, e.methodname])).toEqual([
      [0, 'core_session_touch'],
      [1, 'core_course_get_module'],
    ]);
  });

  it('answers a repeated read from the memo, never a keepalive or a write; a write clears the reads', async () => {
    const { session, fetchMock } = setup(ajaxEcho((fn, args) => ok({ fn, args })));
    await session.ajax('core_courseformat_get_state', { courseid: 99101 });
    await session.ajax('core_courseformat_get_state', { courseid: 99101 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await session.ajax('core_session_touch');
    await session.ajax('core_session_touch');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await session.ajax('core_message_send_instant_messages', { messages: [] });
    await session.ajax('core_courseformat_get_state', { courseid: 99101 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('sends every core_get_fragment alone and at most 25 calls per POST', async () => {
    const { session, fetchMock } = setup(ajaxEcho(() => ok(1)));
    const calls = [
      session.ajax('core_get_fragment', { component: 'core_course', args: [{ name: 'modname', value: 'assign' }] }),
      session.ajax('core_get_fragment', { component: 'core_course', args: [{ name: 'modname', value: 'quiz' }] }),
      ...Array.from({ length: 30 }, (_, i) => session.ajax('core_courseformat_get_state', { courseid: i + 1 })),
    ];
    await Promise.all(calls);
    const sizes = requestsOf(fetchMock).map((r) => bodyOf(r.init).length);
    expect(sizes.sort((x, y) => x - y)).toEqual([1, 1, 5, 25]);
  });

  it('rejects only the entry Moodle refused', async () => {
    const { session } = setup(
      ajaxEcho((fn) =>
        fn === 'bad' ? { error: true, exception: { message: 'Nope', errorcode: 'nopermissions' } } : ok('fine'),
      ),
    );
    const [good, bad] = await Promise.allSettled([session.ajax('good'), session.ajax('bad')]);
    expect(good).toEqual({ status: 'fulfilled', value: 'fine' });
    expect(bad.status).toBe('rejected');
    const err = (bad as PromiseRejectedResult).reason as MoodleError;
    expect(err).toBeInstanceOf(MoodleError);
    expect(err.errorcode).toBe('nopermissions');
    expect(err.message).toBe('Nope');
  });

  it('invalidsesskey: reads the sesskey from a page once and resends the batch once', async () => {
    let posts = 0;
    const { session, fetchMock, onUpdate } = setup((url) => {
      if (url.pathname === '/user/preferences.php') return html(PROFILE);
      posts++;
      if (url.searchParams.get('sesskey') === 'Key0000001') {
        return json({ error: 'Invalid sesskey', errorcode: 'invalidsesskey' });
      }
      return json([ok('done')]);
    });
    await expect(session.ajax('core_session_touch')).resolves.toBe('done');
    expect(posts).toBe(2);
    expect(requestsOf(fetchMock).map((r) => r.url.pathname)).toEqual([
      '/lib/ajax/service.php',
      '/user/preferences.php',
      '/lib/ajax/service.php',
    ]);
    expect(onUpdate).toHaveBeenCalledWith({ sesskey: 'Prof1leKey' });
    expect(await session.sesskey()).toBe('Prof1leKey');
  });

  it('a second invalidsesskey is an error, not a loop', async () => {
    const { session, fetchMock } = setup((url) =>
      url.pathname === '/user/preferences.php'
        ? html(PROFILE)
        : json({ error: 'Invalid sesskey', errorcode: 'invalidsesskey' }),
    );
    await expect(session.ajax('core_session_touch')).rejects.toMatchObject({ errorcode: 'invalidsesskey' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['servicerequireslogin (whole request)', () => json({ error: 'Login', errorcode: 'servicerequireslogin' })],
    [
      'servicerequireslogin (per entry)',
      () => json([{ error: true, exception: { message: 'Login', errorcode: 'servicerequireslogin' } }]),
    ],
    ['a redirect to the login page', () => redirect(`${BASE}/login/index.php`)],
  ])('%s -> NeedsReconnect, onEnded once, no further requests', async (_name, answer) => {
    const { session, fetchMock, onEnded } = setup(answer);
    await expect(session.ajax('core_session_touch')).rejects.toBeInstanceOf(NeedsReconnect);
    await expect(session.page('/my/')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('other whole-request errors -> MoodleError; 5xx, network and garbage -> MoodleUnavailable', async () => {
    const err = setup(() => json({ error: 'Broken', errorcode: 'codingerror' }));
    await expect(err.session.ajax('x')).rejects.toMatchObject({ errorcode: 'codingerror', message: 'Broken' });
    const down = setup(() => new Response('oops', { status: 503 }));
    await expect(down.session.ajax('x')).rejects.toBeInstanceOf(MoodleUnavailable);
    const net = setup(() => {
      throw new TypeError('fetch failed');
    });
    await expect(net.session.ajax('x')).rejects.toBeInstanceOf(MoodleUnavailable);
    const garbage = setup(() => html('<html>maintenance</html>'));
    await expect(garbage.session.ajax('x')).rejects.toBeInstanceOf(MoodleUnavailable);
  });

  it('times out, and says so (onTimeout) only for its own deadline', async () => {
    const onTimeout = vi.fn();
    const { session } = setup(
      (_u, init) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      { timeoutMs: 5, onTimeout },
    );
    await expect(session.ajax('x')).rejects.toBeInstanceOf(MoodleUnavailable);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    const notTimedOut = vi.fn();
    const net = setup(
      () => {
        throw new TypeError('fetch failed');
      },
      { onTimeout: notTimedOut },
    );
    await expect(net.session.ajax('x')).rejects.toBeInstanceOf(MoodleUnavailable);
    const down = setup(() => new Response('oops', { status: 503 }), { onTimeout: notTimedOut });
    await expect(down.session.page('/my/')).rejects.toBeInstanceOf(MoodleUnavailable);
    expect(notTimedOut).not.toHaveBeenCalled();
  });

  it('reports slow and timed-out requests to onSlow, path without query', async () => {
    const onSlow = vi.fn();
    const hung = setup(
      (_u, init) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      { timeoutMs: 5, onSlow },
    );
    await expect(hung.session.page('/course/view.php?id=99')).rejects.toBeInstanceOf(MoodleUnavailable);
    expect(onSlow).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/course/view.php', status: null, timedOut: true }),
    );

    onSlow.mockClear();
    const fast = setup(() => html(PROFILE), { onSlow });
    await fast.session.page('/user/profile.php');
    expect(onSlow).not.toHaveBeenCalled();

    const clock = vi.spyOn(Date, 'now');
    try {
      const slow = setup(
        () => {
          clock.mockReturnValue(Date.now() + 12_000);
          return html(PROFILE);
        },
        { onSlow },
      );
      clock.mockReturnValue(1_000_000);
      await slow.session.page('/user/profile.php');
      expect(onSlow).toHaveBeenCalledWith(expect.objectContaining({ status: 200, timedOut: false, ms: 12_000 }));
    } finally {
      clock.mockRestore();
    }
  });

  it('a page whose body does not arrive in time times out as well', async () => {
    const onTimeout = vi.fn();
    const stalled = (signal: AbortSignal | null | undefined) =>
      new ReadableStream({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
    const { session } = setup((_u, init) => new Response(stalled(init.signal), { status: 200 }), {
      timeoutMs: 5,
      onTimeout,
    });
    await expect(session.page('/my/')).rejects.toBeInstanceOf(MoodleUnavailable);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('a BudgetExceeded from charge() fails the batch without a request', async () => {
    const { session, fetchMock } = setup(
      ajaxEcho(() => ok(1)),
      {
        charge: () => {
          throw new BudgetExceeded();
        },
      },
    );
    await expect(session.ajax('x')).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MoodleWebSession.page', () => {
  it('GETs relative paths with the cookie, memoises by path and picks up the sesskey', async () => {
    const { session, fetchMock, onUpdate } = setup(() => html(PROFILE));
    const page = await session.page('/user/profile.php');
    expect(page).toMatchObject({ url: `${BASE}/user/profile.php`, status: 200, location: null });
    expect(page.html).toContain('page-user-profile');
    await session.page(`${BASE}/user/profile.php`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [req] = requestsOf(fetchMock);
    expect(req?.init.redirect).toBe('manual');
    expect((req?.init.headers as Record<string, string> | undefined)?.Cookie).toBe(COOKIE);
    expect(onUpdate).toHaveBeenCalledWith({ sesskey: 'Prof1leKey' });
  });

  it('refuses other hosts and odd paths without a request', async () => {
    const { session, fetchMock } = setup(() => html(PROFILE));
    await expect(session.page('https://evil.example.com/x')).rejects.toBeInstanceOf(InvalidInput);
    await expect(session.page('//evil.example.com/x')).rejects.toBeInstanceOf(InvalidInput);
    await expect(session.page('user/profile.php')).rejects.toBeInstanceOf(InvalidInput);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows same-origin redirects (each hop charged), at most 3', async () => {
    const hops: Record<string, () => Response> = {
      '/a.php': () => redirect('/b.php'),
      '/b.php': () => redirect(`${BASE}/c.php`),
    };
    const { session, charge } = setup((url) => hops[url.pathname]?.() ?? html('<p>c</p>'));
    const page = await session.page('/a.php');
    expect(page.url).toBe(`${BASE}/c.php`);
    expect(page.html).toBe('<p>c</p>');
    expect(charge).toHaveBeenCalledTimes(3);
    const loop = setup(() => redirect('/loop.php'));
    await expect(loop.session.page('/loop.php')).rejects.toBeInstanceOf(MoodleUnavailable);
    expect(loop.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('follow: false answers the redirect and is not memoised', async () => {
    const file = `${BASE}/pluginfile.php/501/mod_resource/content/1/a.pdf`;
    const { session, fetchMock } = setup(() => redirect(file));
    const page = await session.page('/mod/resource/view.php?id=7001&redirect=0', { follow: false });
    expect(page).toMatchObject({ status: 303, html: '', location: file });
    await session.page('/mod/resource/view.php?id=7001&redirect=0', { follow: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('an external link that merely looks like a login page does not end the session', async () => {
    const { session, onEnded } = setup(() => redirect('https://idp.example.com/idp/profile/SAML2/Redirect/SSO?x=1'));
    await expect(session.page('/mod/url/view.php?id=7001')).resolves.toMatchObject({ status: 303 });
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('does not follow (nor send the cookie to) other origins', async () => {
    const { session, fetchMock } = setup(() => redirect('https://www.example.com/page'));
    const page = await session.page('/mod/url/view.php?id=7001');
    expect(page).toMatchObject({ status: 303, location: 'https://www.example.com/page' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the login page', `${BASE}/login/index.php`],
    ['the SAML login', `${BASE}/auth/saml2/login.php?wants=x`],
  ])('a redirect to %s -> NeedsReconnect + onEnded', async (_n, location) => {
    const { session, onEnded } = setup(() => redirect(location));
    await expect(session.page('/my/')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('a login page body -> NeedsReconnect', async () => {
    const { session, onEnded } = setup(() => html(fixture('core-login-ja.html')));
    await expect(session.page('/my/')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('error pages -> MoodleError with a short code (ja and en, any status)', async () => {
    const ja = setup(() => html(fixture('core-error-nopermission-ja.html'), 404));
    const e = await ja.session.page('/course/user.php?mode=grade&id=99101&user=7001').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MoodleError);
    expect((e as MoodleError).errorcode).toBe('nopermissions');
    // English for the codes we know (Moodle's text is in the session language), with the page to check
    expect((e as MoodleError).message).toBe('Moodle refused access to this page.');
    expect((e as MoodleError).url).toBe(`${BASE}/course/user.php?mode=grade&id=99101&user=7001`);
    const en = setup(() => html(fixture('core-error-record-en.html')));
    await expect(en.session.page('/mod/assign/view.php?id=1')).rejects.toMatchObject({ errorcode: 'invalidrecord' });
    const bare = setup(() => html('<html><body>Not found</body></html>', 404));
    await expect(bare.session.page('/x.php')).rejects.toMatchObject({ errorcode: 'invalidrecord' });
    const down = setup(() => html('busy', 502));
    await expect(down.session.page('/x.php')).rejects.toBeInstanceOf(MoodleUnavailable);
  });

  it('POSTs a form without following; a POST clears the GET memo', async () => {
    const { session, fetchMock } = setup((_u, init) =>
      init.method === 'POST' ? redirect(`${BASE}/mod/assign/view.php?id=7001`) : html('<p>form</p>'),
    );
    await session.page('/mod/assign/view.php?id=7001&action=editsubmission');
    const form = new URLSearchParams({ sesskey: 'Key0000001', id: '7001' });
    const saved = await session.page('/mod/assign/view.php', { method: 'POST', form });
    expect(saved).toMatchObject({ status: 303, html: '', location: `${BASE}/mod/assign/view.php?id=7001` });
    const post = requestsOf(fetchMock)[1];
    expect(String(post?.init.body)).toBe('sesskey=Key0000001&id=7001');
    expect((post?.init.headers as Record<string, string> | undefined)?.['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    await session.page('/mod/assign/view.php?id=7001&action=editsubmission');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('uses a rotated session cookie from then on and reports it (deleted values ignored)', async () => {
    let n = 0;
    const { session, fetchMock, onUpdate } = setup(() => {
      n++;
      const headers = new Headers({ 'content-type': 'text/html' });
      if (n === 1) {
        headers.append('Set-Cookie', 'MoodleSession=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; path=/');
        headers.append('Set-Cookie', 'MoodleSession=rotated0123456789abcdef; path=/; secure; HttpOnly');
      }
      if (n === 2) headers.append('Set-Cookie', 'MoodleSession=deleted; path=/');
      return new Response('<p>x</p>', { headers });
    });
    await session.page('/a.php');
    await session.page('/b.php');
    await session.page('/c.php');
    expect(onUpdate).toHaveBeenCalledWith({ cookie: 'MoodleSession=rotated0123456789abcdef' });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const cookies = requestsOf(fetchMock).map((r) => (r.init.headers as Record<string, string>).Cookie);
    const rotated = 'MoodleSession=rotated0123456789abcdef';
    expect(cookies).toEqual([COOKIE, rotated, rotated]);
  });
});

describe('MoodleWebSession.sesskey', () => {
  it('returns the stored one without a request, else reads it from a page once', async () => {
    const stored = setup(() => html(PROFILE));
    await expect(stored.session.sesskey()).resolves.toBe('Key0000001');
    expect(stored.fetchMock).not.toHaveBeenCalled();
    const fresh = setup(() => html(PROFILE), { sesskey: null });
    const [a, b] = await Promise.all([fresh.session.sesskey(), fresh.session.sesskey()]);
    expect([a, b]).toEqual(['Prof1leKey', 'Prof1leKey']);
    expect(fresh.fetchMock).toHaveBeenCalledTimes(1);
    expect(requestsOf(fresh.fetchMock)[0]?.url.pathname).toBe('/user/preferences.php');
    expect(fresh.onUpdate).toHaveBeenCalledWith({ sesskey: 'Prof1leKey' });
  });
});

describe('MoodleWebSession: a rotated cookie is kept only from an answer that passed the checks', () => {
  const VISITOR = 'MoodleSession=visitor0123456789abcdef';
  const withCookie = (res: Response) => {
    const headers = new Headers(res.headers);
    headers.append('Set-Cookie', `${VISITOR}; path=/; secure; HttpOnly`);
    return new Response(res.body, { status: res.status, headers });
  };

  const LOGIN_REDIRECT = () => redirect(`${BASE}/login/index.php`);
  const LOGIN_PAGE = () => html(fixture('core-login-ja.html'));
  const BUSY = () => html('busy', 503);

  it.each([
    ['a login redirect', LOGIN_REDIRECT],
    ['the login page', LOGIN_PAGE],
    ['a 5xx answer', BUSY],
    ['servicerequireslogin', () => json({ error: 'Login', errorcode: 'servicerequireslogin' })],
    [
      'invalidsesskey, then the sesskey page is the login (a dead session)',
      (url: URL) =>
        url.pathname === '/user/preferences.php' ? LOGIN_REDIRECT() : json({ error: 'x', errorcode: 'invalidsesskey' }),
    ],
  ])('ajax, %s: not stored', async (_name, answer: (url: URL) => Response) => {
    const { session, onUpdate } = setup((url) => withCookie(answer(url)));
    await expect(session.ajax('core_session_touch')).rejects.toBeDefined();
    expect(onUpdate).not.toHaveBeenCalledWith({ cookie: VISITOR });
  });

  it.each([
    ['a login redirect', LOGIN_REDIRECT],
    ['the login page', LOGIN_PAGE],
    ['a 5xx answer', BUSY],
  ])('page, %s: not stored', async (_name, answer) => {
    const { session, onUpdate } = setup(() => withCookie(answer()));
    await expect(session.page('/my/')).rejects.toBeDefined();
    expect(onUpdate).not.toHaveBeenCalledWith({ cookie: VISITOR });
  });

  it('a good ajax answer and a same-origin redirect hop: stored', async () => {
    const ajax = setup(() => withCookie(json([ok(true)])));
    await ajax.session.ajax('core_session_touch');
    expect(ajax.onUpdate).toHaveBeenCalledWith({ cookie: VISITOR });
    const hop = setup((url) => (url.pathname === '/a.php' ? withCookie(redirect(`${BASE}/b.php`)) : html('<p>b</p>')));
    await hop.session.page('/a.php');
    expect(hop.onUpdate).toHaveBeenCalledWith({ cookie: VISITOR });
    const cookies = requestsOf(hop.fetchMock).map((r) => (r.init.headers as Record<string, string>).Cookie);
    expect(cookies).toEqual([COOKIE, VISITOR]);
  });
});

describe('MoodleWebSession: the session ends whichever batch entry says so', () => {
  it('servicerequireslogin after an entry that needs no login -> NeedsReconnect for all, onEnded', async () => {
    const { session, onEnded } = setup(
      ajaxEcho((fn) =>
        fn === 'core_get_string'
          ? ok('文字列')
          : { error: true, exception: { message: 'Login', errorcode: 'servicerequireslogin' } },
      ),
    );
    const [a, b] = await Promise.allSettled([
      session.ajax('core_get_string', { stringid: 'x' }),
      session.ajax('core_course_get_recent_courses'),
    ]);
    expect((a as PromiseRejectedResult).reason).toBeInstanceOf(NeedsReconnect);
    expect((b as PromiseRejectedResult).reason).toBeInstanceOf(NeedsReconnect);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});

describe('MoodleWebSession.writesSent', () => {
  it('counts form POSTs and ajax batches with a write, not reads nor what the login check refused', async () => {
    const { session } = setup((url, init) => {
      if (url.pathname === '/lib/ajax/service.php') return json([ok(true)]);
      if (url.pathname === '/dead.php') return redirect(`${BASE}/login/index.php`);
      return init.method === 'POST' ? redirect(`${BASE}/done.php`) : html('<p>x</p>');
    });
    await session.page('/a.php');
    await session.ajax('core_course_get_recent_courses');
    expect(session.writesSent).toBe(0);
    await session.page('/mod/forum/post.php', { method: 'POST', form: new URLSearchParams({ a: '1' }) });
    await session.ajax('core_message_send_messages_to_conversation', { conversationid: 7001 });
    expect(session.writesSent).toBe(2);
    const refused = await session.page('/dead.php', { method: 'POST' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NeedsReconnect);
    expect(session.writesSent).toBe(2);
  });

  it('an uncertain answer to a POST counts', async () => {
    const { session } = setup(() => html('busy', 502));
    await expect(session.page('/mod/forum/post.php', { method: 'POST' })).rejects.toBeInstanceOf(MoodleUnavailable);
    expect(session.writesSent).toBe(1);
  });
});

describe('MoodleWebSession.seenPage', () => {
  it('finds a page already fetched in the session by its content, without a request', async () => {
    const { session, fetchMock } = setup((url) => html(url.pathname === '/b.php' ? '<p>marker-42</p>' : '<p>x</p>'));
    await session.page('/a.php');
    await session.page('/b.php');
    expect((await session.seenPage(/marker-\d+/))?.url).toBe(`${BASE}/b.php`);
    expect(await session.seenPage(/absent/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
