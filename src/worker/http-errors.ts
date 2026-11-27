/** One WmmError -> HTTP mapping for every JSON error the Worker produces (console API and file routes). */

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { MoodleBusy, MoodleError, MoodleUnavailable, RateLimited, WmmError } from '../core/errors';

const STATUS_BY_CODE: Record<string, ContentfulStatusCode> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  budget_exceeded: 400,
  needs_reconnect: 409,
  mail_needs_reconnect: 409,
  account_switch: 409,
  rate_limited: 429,
  moodle_unavailable: 502,
  moodle_busy: 503,
  mail_unavailable: 502,
};

function httpStatusFor(err: WmmError): ContentfulStatusCode {
  return STATUS_BY_CODE[err.code] ?? (err instanceof MoodleError ? 502 : 500);
}

type ErrorBody = { code: string; message: string; retryAfter?: number; maintenance?: true; until?: string };

/**
 * Machine values the console turns into its own next step: the wait of a rate limit or of a busy Moodle session
 * (also sent as Retry-After), Moodle's maintenance.
 */
function details(err: WmmError): Partial<ErrorBody> {
  if ((err instanceof RateLimited || err instanceof MoodleBusy) && err.retryAfterSec) {
    return { retryAfter: err.retryAfterSec };
  }
  if (err instanceof MoodleUnavailable && err.maintenance) {
    return err.until ? { maintenance: true, until: err.until } : { maintenance: true };
  }
  return {};
}

/** `{ error: { code, message, … } }` for known errors; unknown ones are reported generically (nothing leaks). */
export function errorPayload(err: unknown): { status: ContentfulStatusCode; body: { error: ErrorBody } } {
  if (err instanceof WmmError) {
    const error = { code: err.code, message: err.message, ...details(err) };
    return { status: httpStatusFor(err), body: { error } };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'Something went wrong. Try again later.' } } };
}
