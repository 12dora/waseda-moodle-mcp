// The Moodle web session as the extension sees it. Pure; no chrome.* access here.
import { MOODLE_ORIGIN } from './moodle.js';

/** `chrome.cookies.get` query for the only cookie the extension reads. */
export const SESSION_COOKIE = { url: `${MOODLE_ORIGIN}/`, name: 'MoodleSession' };
const MOODLE_HOST = new URL(MOODLE_ORIGIN).hostname;

// Moodle gives signed-out visitors a MoodleSession cookie too. The probe is a call that needs a sign-in, sent with a
// deliberately wrong sesskey: Moodle checks the sign-in first, so the answer tells both cases apart. Unlike requesting
// a protected page, it does not change where Moodle takes the user after signing in.
export const PROBE_URL = `${MOODLE_ORIGIN}/lib/ajax/service.php?sesskey=probe`;
export const PROBE_BODY = [
  { index: 0, methodname: 'core_message_get_unread_conversations_count', args: { useridto: 0 } },
];

/** True when the probe answer rejects the sesskey, which Moodle only does for a signed-in session. */
export function isSignedInAnswer(body) {
  const error = Array.isArray(body) ? body[0]?.exception : body;
  return error?.errorcode === 'invalidsesskey';
}

function isSessionCookie(cookie) {
  return cookie?.name === SESSION_COOKIE.name && cookie.domain.replace(/^\./, '') === MOODLE_HOST;
}

/**
 * Returns a filter for `chrome.cookies.onChanged`: true when MoodleSession got a new non-empty value. Chrome reports
 * an overwrite as a removal (cause `overwrite`) followed by the new cookie, so a rewrite of the same value is ignored.
 * The replaced value is held in memory between those two events only.
 */
export function createSessionWatcher() {
  let replaced = null;
  return ({ cookie, removed, cause }) => {
    if (!isSessionCookie(cookie)) return false;
    if (removed) {
      replaced = cause === 'overwrite' ? cookie.value : null;
      return false;
    }
    const isNew = Boolean(cookie.value) && cookie.value !== replaced;
    replaced = null;
    return isNew;
  };
}

// 409 = Moodle says the browser's session is signed out; 502/503 = Moodle unreachable or under maintenance
const REFRESH_FAILURES = {
  404: 'unknown_user',
  409: 'signin_required',
  429: 'rate_limited',
  502: 'moodle_unavailable',
  503: 'moodle_unavailable',
};

/** Sync result for an answer of `/api/extension/refresh`. */
export function refreshResult(status, body) {
  if (status < 200 || status >= 300) return REFRESH_FAILURES[status] ?? 'server_error';
  return body?.status === 'unchanged' ? 'unchanged' : 'updated';
}
