/** Error types. Every message is safe to show to the end user and the model (never include tokens). */

export class WmmError extends Error {
  readonly code: string;
  /** The message already says what to do next: the central hints (mcp/error-hints) add nothing. See `withOwnStep`. */
  ownStep = false;
  constructor(message: string, code = 'error') {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Marks an error whose message names its own, more specific next step than the central hint would. */
export function withOwnStep<E extends WmmError>(e: E): E {
  e.ownStep = true;
  return e;
}

/**
 * Moodle returned an exception envelope (`errorcode`) or an unexpected payload. `url` is the Moodle page the error
 * came from (no sesskey), when known: the hints point the user there.
 */
export class MoodleError extends WmmError {
  readonly errorcode: string;
  readonly exception: string;
  readonly url: string | null;
  constructor(message: string, errorcode = 'moodle_error', exception = '', opts: { url?: string | null } = {}) {
    super(message, errorcode || 'moodle_error');
    this.errorcode = errorcode;
    this.exception = exception;
    this.url = opts.url ?? null;
  }
}

/**
 * Network failure, timeout, HTTP 5xx, or Moodle's maintenance page (`maintenance`; `until` = the end time its notice
 * gives, as written there, null when it gives none).
 */
export class MoodleUnavailable extends WmmError {
  readonly maintenance: boolean;
  readonly until: string | null;
  constructor(
    message = 'Waseda Moodle is not reachable right now.',
    opts: { maintenance?: boolean; until?: string | null } = {},
  ) {
    super(message, 'moodle_unavailable');
    this.maintenance = opts.maintenance ?? false;
    this.until = opts.until ?? null;
  }
}

/**
 * Gmail (the Waseda mailbox) is unreachable: network failure, timeout or HTTP 5xx. `maybeSent` is false when the request
 * never reached the Gmail API (e.g. the token refresh failed), so a write cannot have gone through.
 */
export class MailUnavailable extends WmmError {
  readonly maybeSent: boolean;
  constructor(
    message = 'Waseda mail (Gmail) is not reachable right now. Try again later.',
    opts: { maybeSent?: boolean } = {},
  ) {
    super(message, 'mail_unavailable');
    this.maybeSent = opts.maybeSent ?? true;
  }
}

/**
 * No working Moodle connection: the web session ended, or the app token is missing / rejected (errorcode invalidtoken,
 * or accessexception with "token expired"). The local server replaces the message with its own (mcp/wording).
 */
export class NeedsReconnect extends WmmError {
  constructor(message = 'The Moodle connection has ended.', code = 'needs_reconnect') {
    super(message, code);
  }
}

/** The Waseda mail connection is missing, expired or revoked: the user reconnects mail (Settings → Mail), not Moodle. */
export class MailNeedsReconnect extends NeedsReconnect {
  constructor(message: string) {
    super(message, 'mail_needs_reconnect');
  }
}

/** Per-request Moodle call budget exhausted (Workers Free allows 50 subrequests per invocation). */
export class BudgetExceeded extends WmmError {
  constructor(message = 'This request needs more Moodle requests than one call allows.') {
    super(message, 'budget_exceeded');
  }
}

export class NotFound extends WmmError {
  constructor(message: string) {
    super(message, 'not_found');
  }
}

export class Forbidden extends WmmError {
  constructor(message: string) {
    super(message, 'forbidden');
  }
}

export class InvalidInput extends WmmError {
  constructor(message: string) {
    super(message, 'invalid_input');
  }
}

/** `retryAfterSec`: how long to wait at most, when the limiter knows it. */
export class RateLimited extends WmmError {
  readonly retryAfterSec: number | null;
  constructor(message = 'Too many requests.', retryAfterSec: number | null = null) {
    super(message, 'rate_limited');
    this.retryAfterSec = retryAfterSec;
  }
}
