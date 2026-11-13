/**
 * Fake Moodle for the web-session renewal protocol (tool_mobile_get_autologin_key, autologin.php, launch.php).
 * Invented data only. `state` is mutable so a test can expire the token or end the session between steps.
 */

import { MOODLE_URL, md5Hex } from '../../src/core/moodle/launch';

export interface FakeWebState {
  /** The token launch.php returns for a live session. */
  token: string;
  /** Returned with the token by launch.php (null = none). */
  privateToken: string | null;
  /** Session cookies ("MoodleSession=…") Moodle still knows. */
  live: Set<string>;
  /** Error code tool_mobile_get_autologin_key answers with instead of a key. */
  keyError?: string;
  /** autologin.php refuses the key (e.g. requested from another IP). */
  rejectKey?: boolean;
  /** The cookie autologin.php sets (it is then live). */
  newCookie: string;
  /** Throw a network error on every request. */
  down?: boolean;
  /** Only launch.php is unreachable (503). */
  launchDown?: boolean;
  /** Sessions launch.php answers with a page (200, no redirect): neither a token nor the login page. */
  odd?: Set<string>;
}

interface FakeWebRequest {
  path: string;
  userAgent: string;
  cookie: string | null;
  body: URLSearchParams | null;
}

const LOGIN_URL = `${MOODLE_URL}/login/index.php`;

export function fakeMoodleWeb(over: Partial<FakeWebState> = {}) {
  const state: FakeWebState = {
    token: 'a'.repeat(32),
    privateToken: null,
    live: new Set(),
    newCookie: 'MoodleSession=fresh01',
    ...over,
  };
  const requests: FakeWebRequest[] = [];

  const launch = (url: URL, cookie: string | null): Response => {
    if (cookie && state.odd?.has(cookie)) return new Response('<html>launch</html>');
    if (!cookie || !state.live.has(cookie)) {
      return new Response(null, { status: 303, headers: { Location: LOGIN_URL } });
    }
    const passport = url.searchParams.get('passport') ?? '';
    const parts = [md5Hex(MOODLE_URL + passport), state.token, ...(state.privateToken ? [state.privateToken] : [])];
    // like the live Open LMS site: its own app scheme, whatever urlscheme was asked for
    return new Response(null, {
      status: 302,
      headers: { Location: `ltgopenlmsapp://token=${btoa(parts.join(':::'))}` },
    });
  };

  const autologin = (url: URL): Response => {
    if (state.rejectKey || url.searchParams.get('key') !== 'k123') return new Response('<html>error</html>');
    state.live.add(state.newCookie);
    const headers = new Headers({ Location: url.searchParams.get('urltogo') ?? '' });
    headers.append('Set-Cookie', 'MoodleSession=guest00; path=/; secure; HttpOnly');
    headers.append('Set-Cookie', `${state.newCookie}; path=/; secure; HttpOnly`);
    return new Response(null, { status: 303, headers });
  };

  const autologinKey = (): Response => {
    if (state.keyError) {
      return Response.json({ exception: 'moodle_exception', errorcode: state.keyError, message: 'Refused.' });
    }
    return Response.json({ key: 'k123', autologinurl: `${MOODLE_URL}/admin/tool/mobile/autologin.php` });
  };

  const route = (url: URL, { cookie, body }: FakeWebRequest): Response => {
    if (url.pathname === '/admin/tool/mobile/launch.php') {
      return state.launchDown ? new Response('down', { status: 503 }) : launch(url, cookie);
    }
    if (url.pathname === '/admin/tool/mobile/autologin.php') return autologin(url);
    if (url.pathname === '/webservice/rest/server.php' && body?.get('wsfunction') === 'tool_mobile_get_autologin_key') {
      return autologinKey();
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };

  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? new URLSearchParams(init.body) : null;
    const request = {
      path: url.pathname,
      userAgent: headers.get('User-Agent') ?? '',
      cookie: headers.get('Cookie'),
      body,
    };
    requests.push(request);
    if (state.down) throw new TypeError('network down');
    if (url.origin !== MOODLE_URL) throw new Error(`unexpected host ${url.origin}`);
    return route(url, request);
  };

  return { state, requests, fetch: fetch as typeof globalThis.fetch };
}
