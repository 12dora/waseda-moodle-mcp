/**
 * The services' way onto the Moodle web session (channel 'web'): pages and forms that no web-service function
 * emulates (attendance, questionnaires, the activity overview). Every page is charged to the client's call budget.
 */

import type { MoodleApi } from '../../context';
import { MoodleError } from '../../errors';
import { findAll, text } from '../../moodle/web/html';
import type { WebSession } from '../../moodle/web/types';

/** The client's session on the web channel; refuses on the web-service channel (callers dispatch on `api.channel`). */
export function webSessionOf(api: MoodleApi): WebSession {
  const web = api.web;
  if (!web) throw new MoodleError('Not available through the Moodle web session.', 'servicenotavailable');
  return web;
}

/** Path + query of a Moodle URL (absolute or relative), entities decoded; the session takes paths. */
export function pathOf(url: string, baseUrl: string): string {
  const u = url.replace(/&amp;/g, '&');
  return u.startsWith(baseUrl) ? u.slice(baseUrl.length) || '/' : u;
}

const NOTICE_CLASSES = ['notifyproblem', 'notifymessage', 'alert-danger', 'alert-warning', 'alert-info', 'error'];
const MAX_NOTICE = 300;

/**
 * Moodle's notices and form errors in a page fragment (plain text, joined, bounded); null when there are none.
 * `extra`: further classes that carry notices on this page.
 */
export function noticesIn(html: string, extra: readonly string[] = []): string | null {
  const out: string[] = [];
  for (const cls of [...NOTICE_CLASSES, ...extra]) {
    for (const el of findAll(html, { attr: 'class', value: cls, word: true })) {
      const t = text(el.inner);
      if (t && !out.includes(t)) out.push(t);
    }
  }
  const joined = out.join(' ');
  return joined ? joined.slice(0, MAX_NOTICE) : null;
}
