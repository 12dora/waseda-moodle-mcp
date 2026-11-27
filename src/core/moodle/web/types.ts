/**
 * The Moodle web session channel (see MoodleChannel in core/context.ts). A WebSession is one user's MoodleSession
 * cookie plus its sesskey, used for one invocation; adapters (WebFn) emulate web-service functions on top of it.
 * The cookie and sesskey are credentials: never log them, never send them anywhere but MOODLE_URL.
 */

import type { CallHint } from '../../context';

export interface WebRequest {
  method?: 'GET' | 'POST';
  /** POST body (application/x-www-form-urlencoded). The sesskey is NOT added automatically. */
  form?: URLSearchParams;
  /** GET only: false = do not follow a redirect, answer with its `location` (e.g. a resource that 303s to its file). */
  follow?: boolean;
}

export interface WebPage {
  /** The final URL after followed redirects (GET), or the requested URL (POST). */
  readonly url: string;
  readonly status: number;
  /** The decoded body ('' for a redirect answer to a POST). */
  readonly html: string;
  /** The Location of an unfollowed 3xx answer (absolute URL), null otherwise. Moodle answers a saved form with 303. */
  readonly location: string | null;
}

export interface WebSession {
  readonly baseUrl: string;
  readonly moodleUserId: number;
  /**
   * One ajax-enabled external function through /lib/ajax/service.php. Calls issued in the same tick share one HTTP
   * request (Moodle runs them in order, one session lock). Throws MoodleError (errorcode from Moodle),
   * NeedsReconnect (session ended), MoodleUnavailable, BudgetExceeded.
   */
  ajax<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
  /**
   * A Moodle page, path relative to baseUrl (e.g. `/mod/assign/view.php?id=12`). GET: same-origin redirects followed
   * (at most 3), memoised per session object by path. POST: never memoised, redirects not followed (see location).
   * Throws NeedsReconnect when Moodle sends the request to its login page, MoodleError for a Moodle error page
   * (code 'nopermissions', 'invalidrecord', 'requireloginerror', ... or 'moodle_error'), MoodleUnavailable for 5xx,
   * network failures and timeouts, BudgetExceeded.
   */
  page(path: string, req?: WebRequest): Promise<WebPage>;
  /** The session's sesskey (read from a page once, then cached; refreshed after an invalidsesskey answer). */
  sesskey(): Promise<string>;
}

/** Emulates one web-service function on the web channel. Returns the same JSON shape for the fields callers read. */
type WebFn = (web: WebSession, params: Record<string, unknown>, hint: CallHint) => Promise<unknown>;

/** A module's emulated functions, keyed by web-service function name. */
export type WebFunctions = Readonly<Record<string, WebFn>>;
