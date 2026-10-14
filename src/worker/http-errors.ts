/** One WmmError -> HTTP mapping for every JSON error the Worker produces (console API and file routes). */

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { MoodleError, WmmError } from '../core/errors';

const STATUS_BY_CODE: Record<string, ContentfulStatusCode> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  budget_exceeded: 400,
  needs_reconnect: 409,
  account_switch: 409,
  rate_limited: 429,
  moodle_unavailable: 502,
};

function httpStatusFor(err: WmmError): ContentfulStatusCode {
  return STATUS_BY_CODE[err.code] ?? (err instanceof MoodleError ? 502 : 500);
}

/** `{ error: { code, message } }` for known errors; unknown ones are reported generically (nothing leaks). */
export function errorPayload(err: unknown): { status: ContentfulStatusCode; body: { error: Record<string, string> } } {
  if (err instanceof WmmError) {
    return { status: httpStatusFor(err), body: { error: { code: err.code, message: err.message } } };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'Something went wrong. Try again later.' } } };
}
