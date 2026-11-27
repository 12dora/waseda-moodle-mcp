/** Error types. Every message is safe to show to the end user and the model (never include tokens). */

export class WmmError extends Error {
  readonly code: string;
  constructor(message: string, code = 'error') {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Moodle returned an exception envelope (`errorcode`) or an unexpected payload. */
export class MoodleError extends WmmError {
  readonly errorcode: string;
  readonly exception: string;
  constructor(message: string, errorcode = 'moodle_error', exception = '') {
    super(message, errorcode || 'moodle_error');
    this.errorcode = errorcode;
    this.exception = exception;
  }
}

/** Network failure, timeout, HTTP 5xx or maintenance page. */
export class MoodleUnavailable extends WmmError {
  constructor(message = 'Waseda Moodle is not reachable right now. Try again later.') {
    super(message, 'moodle_unavailable');
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
  constructor(
    message = 'The Moodle connection has ended. Reconnect in the console (browser extension or Moodle session cookie).',
    code = 'needs_reconnect',
  ) {
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
  constructor(message = 'Too many Moodle requests in one call. Narrow the request (e.g. pass course_id).') {
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

export class RateLimited extends WmmError {
  constructor(message = 'Too many requests. Slow down and retry shortly.') {
    super(message, 'rate_limited');
  }
}
