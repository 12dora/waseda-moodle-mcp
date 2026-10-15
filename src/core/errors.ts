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

/** Stored token missing/invalid/expired (errorcode invalidtoken, or accessexception with "token expired"). */
export class NeedsReconnect extends WmmError {
  constructor(
    message = 'The Moodle connection has expired. Connect again (in the console, or with the connect command in local mode).',
  ) {
    super(message, 'needs_reconnect');
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
