/**
 * Moodle web session that renews the mobile token (policy: services/credential-renewal). Talks to MOODLE_URL only.
 *   1. tool_mobile_get_autologin_key (token + private token, app User-Agent) -> a single-use key (~1 min, IP-bound)
 *   2. autologin.php?userid&key&urltogo=<launch URL>                        -> 303 with the MoodleSession cookie
 *   3. launch.php with the cookie -> 302 to `<scheme>://token=…`: the current token (a new one once it expired)
 * The cookie is a credential: never log it and never send it anywhere else.
 */

import { MoodleUnavailable, WmmError } from '../errors';
import { type LaunchToken, launchUrl, MOODLE_URL, parseLaunch } from './launch';
import { isObj, readEnvelope } from './wire';

/** Moodle hands out autologin keys only to its app (`core_useragent::is_moodle_app` looks for "MoodleMobile"). */
const APP_USER_AGENT = 'Mozilla/5.0 (compatible; WasedaMoodleMCP) MoodleMobile';
const TIMEOUT_MS = 15_000;
const LAUNCH_PATH = '/admin/tool/mobile/launch.php';
const APP_SCHEME = 'moodlemobile://'; // the urlscheme launchUrl asks for
/** The session cookie (the name may carry the site's `sessioncookie` suffix); "deleted" values never match. */
const SESSION_COOKIE = /^\s*(MoodleSession\w*)=([A-Za-z0-9,-]+)\s*(?:;|$)/;

type SessionLaunch = { ok: true; launch: LaunchToken; cookie: string } | { ok: false };
type SessionOpen = { ok: true; cookie: string } | { ok: false; reason: string };

const randomPassport = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

const discard = (res: Response) => {
  res.body?.cancel().catch(() => {});
};

const locationOf = (res: Response) => (res.status >= 300 && res.status < 400 ? res.headers.get('location') : null);

/**
 * One request, never following redirects, read by `read` under the same deadline (headers AND body). Network
 * failures, timeouts, 5xx and unreadable answers -> MoodleUnavailable; a BudgetExceeded from a metered fetch passes.
 */
async function exchange<T>(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  read: (res: Response) => T | Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new MoodleUnavailable());
    }, TIMEOUT_MS);
  });
  const work = (async () => {
    const headers = { 'User-Agent': APP_USER_AGENT, ...(init.headers as Record<string, string> | undefined) };
    const res = await doFetch(url, { ...init, headers, redirect: 'manual', signal: ac.signal });
    try {
      if (res.status >= 500) throw new MoodleUnavailable();
      return await read(res);
    } finally {
      discard(res); // an unread body; a no-op once it was read
    }
  })();
  work.catch(() => {}); // settles after a lost race
  try {
    return await Promise.race([work, deadline]);
  } catch (e) {
    throw e instanceof WmmError ? e : new MoodleUnavailable();
  } finally {
    clearTimeout(timer);
  }
}

/** The last session cookie the response sets (Moodle sends several while it regenerates the session). */
function sessionCookie(res: Response): string | null {
  let found: string | null = null;
  for (const line of res.headers.getSetCookie()) {
    const m = SESSION_COOKIE.exec(line);
    if (m) found = `${m[1]}=${m[2]}`;
  }
  return found;
}

/** Step 3. `{ ok: false }` = the session has ended (launch.php sends the browser to the login page instead). */
export async function launchWithSession(doFetch: typeof fetch, cookie: string): Promise<SessionLaunch> {
  const passport = randomPassport();
  return exchange(doFetch, launchUrl(passport, false), { headers: { Cookie: cookie } }, (res): SessionLaunch => {
    const location = locationOf(res);
    if (!location) throw new MoodleUnavailable();
    if (!location.toLowerCase().startsWith(APP_SCHEME)) return { ok: false };
    let launch: LaunchToken;
    try {
      launch = parseLaunch(location, passport);
    } catch {
      throw new MoodleUnavailable();
    }
    if (launch.signatureOk !== true) throw new MoodleUnavailable();
    return { ok: true, launch, cookie: sessionCookie(res) ?? cookie };
  });
}

/** Step 1. A refusal carries Moodle's error code (apprequired, autologinkeygenerationlockout, invalidprivatetoken…). */
async function autologinKey(
  doFetch: typeof fetch,
  token: string,
  privateToken: string,
): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
  const body = new URLSearchParams({
    wstoken: token,
    wsfunction: 'tool_mobile_get_autologin_key',
    moodlewsrestformat: 'json',
    privatetoken: privateToken,
  });
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  };
  const data = await exchange(doFetch, `${MOODLE_URL}/webservice/rest/server.php`, init, async (res) => {
    if (locationOf(res)) throw new MoodleUnavailable();
    return JSON.parse(await res.text()) as unknown; // a SyntaxError becomes MoodleUnavailable
  });
  const refused = isObj(data) ? readEnvelope(data) : null;
  if (refused) return { ok: false, reason: refused.code || 'moodle_error' };
  const key = isObj(data) ? data.key : undefined;
  return typeof key === 'string' && /^[A-Za-z0-9]+$/.test(key) ? { ok: true, key } : { ok: false, reason: 'bad_key' };
}

/** Steps 1–2: opens a web session for the token's user. The key is used at once, in the same invocation. */
export async function openSession(
  doFetch: typeof fetch,
  opts: { token: string; privateToken: string; moodleUserId: number },
): Promise<SessionOpen> {
  const key = await autologinKey(doFetch, opts.token, opts.privateToken);
  if (!key.ok) return key;
  const query = new URLSearchParams({
    userid: String(opts.moodleUserId),
    key: key.key,
    urltogo: launchUrl(randomPassport(), false),
  });
  const url = `${MOODLE_URL}/admin/tool/mobile/autologin.php?${query}`;
  return exchange(doFetch, url, {}, (res): SessionOpen => {
    const location = locationOf(res);
    const cookie = sessionCookie(res);
    // a rejected key (expired, or requested from another IP) ends on an error or login page, not at urltogo
    if (!location || !cookie || !isLaunchUrl(location)) return { ok: false, reason: 'autologin_rejected' };
    return { ok: true, cookie };
  });
}

function isLaunchUrl(location: string): boolean {
  try {
    const url = new URL(location, MOODLE_URL);
    return url.origin === MOODLE_URL && url.pathname === LAUNCH_PATH;
  } catch {
    return false;
  }
}
