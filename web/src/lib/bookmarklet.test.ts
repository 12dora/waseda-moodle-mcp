import { describe, expect, it } from 'vitest';
import { bookmarkletHref, bookmarkletSource, encodeJsUrlBody, MOODLE_ORIGIN } from './bookmarklet';

const S = 'https://wasemoodle.example.com';
const MSGS = {
  signin: 'Waseda Moodle にサインインしてから、もう一度クリックしてください。',
  fail: "Can't connect. Reload",
};

type Loc = { origin: string; href: string };
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; credentials?: string };
type FakeResponse = { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> };
type FakeFetch = (url: string, init?: FetchInit) => Promise<FakeResponse>;
type Run = (location: Loc, fetch: FakeFetch, alert: (m: string) => void) => Promise<void>;

function compile(src: string): Run {
  return new Function('location', 'fetch', 'alert', `return ${src}`) as Run;
}

function response(status: number, body: string): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  };
}

function fakeFetch(moodleHtml: string, handoffStatus = 200) {
  const calls: Array<{ url: string; init?: FetchInit }> = [];
  const fn = (url: string, init?: FetchInit) => {
    calls.push({ url, init });
    if (url.startsWith(MOODLE_ORIGIN)) return Promise.resolve(response(200, moodleHtml));
    return Promise.resolve(response(handoffStatus, JSON.stringify({ code: 'hnd_abc' })));
  };
  return { fn, calls };
}

describe('bookmarkletHref', () => {
  const href = bookmarkletHref(`${S}/`, MSGS);

  it('is a javascript: URL that decodes back to the source', () => {
    expect(href.startsWith('javascript:')).toBe(true);
    expect(decodeURIComponent(href.slice('javascript:'.length))).toBe(bookmarkletSource(S, MSGS));
  });

  it('contains no characters that break the URL', () => {
    expect(href).not.toMatch(/[#\s"<>`]/);
    expect(href).not.toMatch(/[^\x20-\x7e]/);
  });

  it('strips the trailing slash from PUBLIC_URL and escapes quotes in messages', () => {
    const src = bookmarkletSource(`${S}/`, MSGS);
    expect(src).toContain(`const S='${S}',M='${MOODLE_ORIGIN}'`);
    expect(src).toContain("alert('Can\\'t connect. Reload')");
  });

  it('never puts the launch link in a URL', () => {
    expect(bookmarkletSource(S, MSGS)).not.toContain('launch=');
  });

  it('is valid JavaScript', () => {
    expect(() => compile(bookmarkletSource(S, MSGS))).not.toThrow();
  });

  it('only encodes what is necessary', () => {
    expect(encodeJsUrlBody("a b#c%d'e(f)")).toBe("a%20b%23c%25d'e(f)");
  });
});

describe('bookmarklet behaviour', () => {
  const run = compile(bookmarkletSource(S, MSGS));

  it('sends the user to Moodle when run elsewhere', async () => {
    const loc = { origin: S, href: `${S}/connect` };
    const { fn, calls } = fakeFetch('');
    await run(loc, fn, () => {});
    expect(loc.href).toBe(`${MOODLE_ORIGIN}/my/`);
    expect(calls).toHaveLength(0);
  });

  it('posts the launch link to the handoff endpoint and redirects with the code', async () => {
    const html = '<p><a class="btn" id="launchapp" href="ltgopenlmsapp://token=QUJD&amp;x=1">Open</a></p>';
    const { fn, calls } = fakeFetch(html);
    const loc = { origin: MOODLE_ORIGIN, href: `${MOODLE_ORIGIN}/my/` };
    await run(loc, fn, () => {});

    expect(calls).toHaveLength(2);
    const [launchCall, handoff] = calls;
    expect(launchCall?.url).toMatch(/\/launch\.php\?service=moodle_mobile_app&passport=[a-z0-9]+&/);
    expect(launchCall?.url).toMatch(/&urlscheme=moodlemobile&confirmed=1$/);
    expect(launchCall?.init?.credentials).toBe('include');
    const passport = /passport=([a-z0-9]+)/.exec(launchCall?.url ?? '')?.[1];

    expect(handoff?.url).toBe(`${S}/api/connect/handoff`);
    expect(handoff?.init?.method).toBe('POST');
    expect(handoff?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(handoff?.init?.body ?? '{}')).toEqual({
      launch: 'ltgopenlmsapp://token=QUJD&x=1',
      via: 'bookmarklet',
      passport,
    });
    expect(loc.href).toBe(`${S}/connect?code=hnd_abc`);
  });

  it('accepts href before id', async () => {
    const { fn, calls } = fakeFetch('<a href="ltgopenlmsapp://token=Wg" id="launchapp">');
    const loc = { origin: MOODLE_ORIGIN, href: '' };
    await run(loc, fn, () => {});
    expect(JSON.parse(calls[1]?.init?.body ?? '{}').launch).toBe('ltgopenlmsapp://token=Wg');
  });

  it('alerts when not signed in, on handoff errors and on failure', async () => {
    const alerts: string[] = [];
    const loc = { origin: MOODLE_ORIGIN, href: '' };
    await run(loc, fakeFetch('<html>login</html>').fn, (m) => alerts.push(m));
    await run(loc, fakeFetch('<a id="launchapp" href="x://token=a">', 429).fn, (m) => alerts.push(m));
    await run(
      loc,
      () => Promise.reject(new Error('x')),
      (m) => alerts.push(m),
    );
    expect(alerts).toEqual([MSGS.signin, MSGS.fail, MSGS.fail]);
    expect(loc.href).toBe('');
  });
});
