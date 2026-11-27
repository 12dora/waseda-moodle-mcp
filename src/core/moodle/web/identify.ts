/**
 * Who a pasted MoodleSession cookie belongs to: the cookie is normalised, then the user's own profile page is read
 * (M.cfg userId + sesskey, the page heading = the full name). Connect flows call this before storing a session.
 */

import { InvalidInput, MoodleError, MoodleUnavailable, NeedsReconnect } from '../../errors';
import { findFirst, pageConfig, text } from './html';
import { MoodleWebSession } from './session';

const PASTE_MSG = 'Paste the value of the MoodleSession cookie.';
const ENDED_MSG = 'The Moodle session has ended. Sign in to Moodle again and copy a new cookie.';
const VALUE = /^[A-Za-z0-9,-]{20,128}$/;
const IN_HEADER = /(?:^|[;\s])MoodleSession=([^;\s]*)/;
/** identifySession's own allowance: the profile page and one redirect. */
const ALLOWANCE = 2;

/**
 * 'MoodleSession=<value>' from the bare value, `MoodleSession=<v>`, a Set-Cookie style `MoodleSession=<v>; path=/…`
 * or a whole `Cookie:` header that contains it. Throws InvalidInput otherwise.
 */
export function normalizeSessionCookie(input: string): string {
  const s = input.trim().replace(/^cookie:\s*/i, '');
  const value = VALUE.test(s) ? s : (IN_HEADER.exec(s)?.[1] ?? '');
  if (!VALUE.test(value)) throw new InvalidInput(PASTE_MSG);
  return `MoodleSession=${value}`;
}

export interface Identity {
  moodleUserId: number;
  fullname: string;
  /** The session's interface language (ja, en, …), null when the page does not say. */
  lang: string | null;
  sesskey: string;
}

/** The profile page's heading: `<div class="page-header-headings"><h1 class="h2 …">Full Name</h1>`. */
function profileName(html: string): string {
  const head = findFirst(html, { attr: 'class', value: 'page-header-headings', word: true });
  const h1 = head ? findFirst(head.inner, { attr: 'class', tag: 'h1' }) : null;
  return h1 ? text(h1.inner) : '';
}

/** The signed-in user of a `/user/profile.php` page, or null when the page has no user or sesskey. */
export function parseIdentity(html: string): Identity | null {
  const cfg = pageConfig(html);
  if (!cfg.userId || !cfg.sesskey) return null;
  return { moodleUserId: cfg.userId, fullname: profileName(html), lang: cfg.lang, sesskey: cfg.sesskey };
}

/** Reads the cookie's user from Moodle. The answer carries the cookie to store (Moodle may rotate it). */
export async function identifySession(doFetch: typeof fetch, cookie: string): Promise<Identity & { cookie: string }> {
  let current = cookie;
  let left = ALLOWANCE;
  const session = new MoodleWebSession({
    cookie,
    moodleUserId: 0,
    fetch: doFetch,
    charge: () => {
      if (left-- <= 0) throw new MoodleUnavailable('Moodle redirected the profile page unexpectedly.');
    },
    onUpdate: (u) => {
      if (u.cookie) current = u.cookie;
    },
  });
  let html: string;
  try {
    html = (await session.page('/user/profile.php')).html;
  } catch (e) {
    throw e instanceof NeedsReconnect ? new NeedsReconnect(ENDED_MSG) : e;
  }
  const who = parseIdentity(html);
  if (!who) throw new MoodleError('Moodle did not show the profile page.', 'moodle_error');
  return { ...who, cookie: current };
}
