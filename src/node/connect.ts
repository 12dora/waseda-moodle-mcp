/** `waseda-moodle-mcp connect`: checks a pasted session cookie or launch link and saves it. */

import { InvalidInput, NeedsReconnect } from '../core/errors';
import { parseLaunch } from '../core/moodle/launch';
import { identifySession, normalizeSessionCookie } from '../core/moodle/web/identify';
import { type Credential, readCredentialFile, writeCredential } from './credential-file';
import { identifyToken } from './identify';

interface Connected {
  fullname: string;
  /** What the credential file holds now. */
  credential: Credential;
}

/** `<scheme>://…` (also URL-encoded) or `token=…`, possibly inside the quotes or brackets that copying adds. */
const LAUNCH_LINK = /^["'`<([\s]*(?:[a-z][a-z0-9+.-]*(?::\/\/|%3a%2f%2f)|token=)/i;
const BARE_HEX = /^[0-9a-f]{32}$/i;

/** The token of a launch link (or of its bare payload); null when the input has to be read as a session cookie. */
function launchToken(input: string): string | null {
  if (LAUNCH_LINK.test(input)) return parseLaunch(input).token; // a broken link reports itself
  if (BARE_HEX.test(input)) return null; // tried as a cookie first
  try {
    return parseLaunch(input).token;
  } catch {
    return null;
  }
}

/** Whose the saved token is: recorded with it, else (a plain token file) asked from Moodle; null when unknown. */
async function tokenOwner(token: string, saved: Credential, doFetch: typeof fetch): Promise<number | null> {
  if (saved.moodleUserId) return saved.moodleUserId;
  return identifyToken(token, doFetch).then(
    (who) => who.moodleUserId,
    () => null,
  );
}

/** Saves the session; a stored token stays only when it is known to be the same user's. */
async function fromSession(cookie: string, saved: Credential | null, doFetch: typeof fetch): Promise<Connected> {
  const who = await identifySession(doFetch, cookie);
  const credential: Credential = { session: who.cookie, sesskey: who.sesskey, moodleUserId: who.moodleUserId };
  if (saved?.token && (await tokenOwner(saved.token, saved, doFetch)) === who.moodleUserId) {
    credential.token = saved.token;
  }
  return { fullname: who.fullname || `User ${who.moodleUserId}`, credential };
}

/** Saves the token; a stored session stays only when it is the same user's. */
async function fromToken(token: string, saved: Credential | null, doFetch: typeof fetch): Promise<Connected> {
  const who = await identifyToken(token, doFetch).catch((e: unknown) => {
    if (e instanceof NeedsReconnect)
      throw new InvalidInput('Moodle rejected that token. Get a fresh link (see --help).');
    throw e;
  });
  const credential: Credential = { token, moodleUserId: who.moodleUserId };
  if (saved?.session && saved.moodleUserId === who.moodleUserId) {
    credential.session = saved.session;
    credential.sesskey = saved.sesskey;
  }
  return { fullname: who.fullname, credential };
}

async function check(input: string, saved: Credential | null, doFetch: typeof fetch): Promise<Connected> {
  const token = launchToken(input);
  if (token) return fromToken(token, saved, doFetch);
  try {
    return await fromSession(normalizeSessionCookie(input), saved, doFetch);
  } catch (e) {
    if (!(e instanceof NeedsReconnect)) throw e;
    const ended = new InvalidInput(e.message);
    if (!BARE_HEX.test(input)) throw ended;
    // 32 hex characters can also be a bare app token
    return fromToken(input.toLowerCase(), saved, doFetch).catch(() => {
      throw ended;
    });
  }
}

export async function connect(input: string, opts: { file: string; fetch: typeof fetch }): Promise<Connected> {
  const saved = await readCredentialFile(opts.file).catch(() => null); // a damaged file is simply replaced
  const result = await check(input.trim(), saved, opts.fetch);
  await writeCredential(opts.file, result.credential);
  return result;
}
