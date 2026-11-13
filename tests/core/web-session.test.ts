import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceeded, MoodleUnavailable } from '../../src/core/errors';
import { MOODLE_URL } from '../../src/core/moodle/launch';
import { launchWithSession, openSession } from '../../src/core/moodle/web-session';
import { fakeMoodleWeb } from '../helpers/fake-moodle-web';

const TOKEN = 'b'.repeat(32);
const LIVE = 'MoodleSession=live01';

describe('launchWithSession', () => {
  it('returns the token launch.php hands to a live session, checked against the passport', async () => {
    const web = fakeMoodleWeb({ token: TOKEN, privateToken: 'Priv4teTok3n', live: new Set([LIVE]) });
    const r = await launchWithSession(web.fetch, LIVE);
    expect(r).toEqual({
      ok: true,
      cookie: LIVE,
      launch: { token: TOKEN, privateToken: 'Priv4teTok3n', signatureOk: true },
    });
    expect(web.requests).toHaveLength(1);
    expect(web.requests[0]).toMatchObject({ path: '/admin/tool/mobile/launch.php', cookie: LIVE });
    expect(web.requests[0]?.userAgent).toContain('MoodleMobile');
  });

  it('reports an ended session (redirect to the login page)', async () => {
    const web = fakeMoodleWeb();
    expect(await launchWithSession(web.fetch, LIVE)).toEqual({ ok: false });
  });

  it('treats a bad signature, a missing redirect and failures as unavailable, not as an ended session', async () => {
    const forged = (async () =>
      new Response(null, {
        status: 302,
        headers: { Location: `moodlemobile://token=${btoa(`${'0'.repeat(32)}:::${TOKEN}`)}` },
      })) as typeof fetch;
    await expect(launchWithSession(forged, LIVE)).rejects.toBeInstanceOf(MoodleUnavailable);
    const page = (async () => new Response('<html></html>')) as typeof fetch;
    await expect(launchWithSession(page, LIVE)).rejects.toBeInstanceOf(MoodleUnavailable);
    const web = fakeMoodleWeb({ down: true });
    await expect(launchWithSession(web.fetch, LIVE)).rejects.toBeInstanceOf(MoodleUnavailable);
    const broken = (async () => new Response('down', { status: 503 })) as typeof fetch;
    await expect(launchWithSession(broken, LIVE)).rejects.toBeInstanceOf(MoodleUnavailable);
  });
});

describe('openSession', () => {
  const opts = { token: TOKEN, privateToken: 'Priv4teTok3n', moodleUserId: 1001 };

  it('exchanges an autologin key for the last session cookie, with the app User-Agent, on Moodle only', async () => {
    const web = fakeMoodleWeb({ newCookie: 'MoodleSession=fresh01' });
    expect(await openSession(web.fetch, opts)).toEqual({ ok: true, cookie: 'MoodleSession=fresh01' });
    const paths = web.requests.map((r) => r.path);
    expect(paths).toEqual(['/webservice/rest/server.php', '/admin/tool/mobile/autologin.php']);
    expect(web.requests.every((r) => r.userAgent.includes('MoodleMobile'))).toBe(true);
    expect(Object.fromEntries(web.requests[0]?.body ?? [])).toMatchObject({
      wstoken: TOKEN,
      wsfunction: 'tool_mobile_get_autologin_key',
      privatetoken: 'Priv4teTok3n',
    });
  });

  it('passes the user id and a launch URL on Moodle as urltogo', async () => {
    let seen: URL | undefined;
    const web = fakeMoodleWeb();
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/autologin.php')) seen = url;
      return web.fetch(input, init);
    }) as typeof fetch;
    await openSession(spy, opts);
    expect(seen?.searchParams.get('userid')).toBe('1001');
    const togo = new URL(seen?.searchParams.get('urltogo') ?? '');
    expect(togo.origin).toBe(MOODLE_URL);
    expect(togo.pathname).toBe('/admin/tool/mobile/launch.php');
    expect(togo.searchParams.get('confirmed')).toBeNull();
  });

  it('returns Moodle’s refusal code (app required, rate limit) without opening anything', async () => {
    for (const code of ['apprequired', 'autologinkeygenerationlockout']) {
      const web = fakeMoodleWeb({ keyError: code });
      expect(await openSession(web.fetch, opts)).toEqual({ ok: false, reason: code });
      expect(web.requests).toHaveLength(1);
    }
  });

  it('reports a key that autologin.php does not accept (expired, other IP)', async () => {
    const web = fakeMoodleWeb({ rejectKey: true });
    expect(await openSession(web.fetch, opts)).toEqual({ ok: false, reason: 'autologin_rejected' });
  });
});

describe('deadlines', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the deadline through the body: a stalled autologin-key answer ends as unavailable', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const stalled = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      // headers at once, then a body that never arrives
      return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const opening = openSession(stalled, { token: TOKEN, privateToken: 'Priv4teTok3n', moodleUserId: 1001 });
    const outcome = expect(opening).rejects.toBeInstanceOf(MoodleUnavailable);
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;
    expect(aborted).toBe(true);
  });

  it('passes a budget refusal of a metered fetch through unchanged', async () => {
    const dry = (async () => {
      throw new BudgetExceeded();
    }) as typeof fetch;
    await expect(launchWithSession(dry, LIVE)).rejects.toBeInstanceOf(BudgetExceeded);
  });
});
