/**
 * Fake Moodle for the web-session keepalive: the public site config, the sesskey page and `core_session_touch` through
 * /lib/ajax/service.php. Invented data only. `state` is mutable so a test can end the session between steps. Requests
 * for the token renewal protocol go to `other` (fake-moodle-web).
 */

import { MOODLE_URL } from '../../src/core/moodle/launch';

export const SESSKEY = 'Sk00000001';

interface FakeSessionState {
  /** Session cookies ("MoodleSession=…") Moodle still knows. */
  live: Set<string>;
  /** The mobile web service flag of the public config. */
  mobileService: boolean;
  /** Throw a network error on every request. */
  down?: boolean;
  /** Sessions whose ajax requests answer 503. */
  broken?: Set<string>;
  /** Cookie -> the cookie Moodle replaces it with on the next ajax answer. */
  rotate?: Map<string, string>;
}

interface FakeSessionRequest {
  path: string;
  cookie: string | null;
  sesskey: string | null;
}

const LOGIN = `${MOODLE_URL}/login/index.php`;

export function fakeMoodleSession(over: Partial<FakeSessionState> = {}, other?: typeof globalThis.fetch) {
  const state: FakeSessionState = { live: new Set(), mobileService: false, ...over };
  const requests: FakeSessionRequest[] = [];

  const publicConfig = () =>
    Response.json([{ error: false, data: { enablemobilewebservice: state.mobileService ? 1 : 0 } }]);

  const preferences = (cookie: string | null) =>
    cookie && state.live.has(cookie)
      ? new Response(`<html lang="en"><script>M.cfg = {"sesskey":"${SESSKEY}","userId":7001};</script></html>`)
      : new Response(null, { status: 303, headers: { Location: LOGIN } });

  const ajax = (cookie: string | null) => {
    if (cookie && state.broken?.has(cookie)) return new Response('down', { status: 503 });
    if (!cookie || !state.live.has(cookie)) {
      const exception = { errorcode: 'servicerequireslogin', message: 'Please sign in.' };
      return Response.json([{ error: true, exception }]);
    }
    const next = state.rotate?.get(cookie);
    const headers = new Headers();
    if (next) {
      headers.append('Set-Cookie', `${next}; path=/; secure; HttpOnly`);
      state.live.delete(cookie);
      state.live.add(next);
    }
    return Response.json([{ error: false, data: true }], { headers });
  };

  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const cookie = new Headers(init.headers).get('Cookie');
    const known = ['/lib/ajax/service-nologin.php', '/lib/ajax/service.php', '/user/preferences.php'];
    if (other && !known.includes(url.pathname)) return other(input, init);
    requests.push({ path: url.pathname, cookie, sesskey: url.searchParams.get('sesskey') });
    if (state.down) throw new TypeError('network down');
    if (url.pathname === '/lib/ajax/service-nologin.php') return publicConfig();
    if (url.pathname === '/user/preferences.php') return preferences(cookie);
    if (url.pathname === '/lib/ajax/service.php') return ajax(cookie);
    throw new Error(`unexpected request ${url.pathname}`);
  };

  return { state, requests, fetch: fetch as typeof globalThis.fetch };
}
