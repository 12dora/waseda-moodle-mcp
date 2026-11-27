import { describe, expect, it } from 'vitest';
import { MoodleUnavailable, NotFound, RateLimited } from '../../src/core/errors';
import { errorPayload } from '../../src/worker/http-errors';

describe('errorPayload', () => {
  it('adds the machine values the console turns into a next step', () => {
    const limited = errorPayload(new RateLimited(undefined, 600)).body.error;
    expect(limited).toMatchObject({ code: 'rate_limited', retryAfter: 600 });
    const until = new MoodleUnavailable('Waseda Moodle is under maintenance.', { maintenance: true, until: '06:00' });
    expect(errorPayload(until)).toMatchObject({ status: 502, body: { error: { maintenance: true, until: '06:00' } } });
  });

  it('keeps plain errors as code and message only', () => {
    expect(errorPayload(new RateLimited()).body.error).toEqual({ code: 'rate_limited', message: 'Too many requests.' });
    expect(errorPayload(new MoodleUnavailable()).body.error).not.toHaveProperty('maintenance');
    expect(errorPayload(new NotFound('Not found.'))).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'Not found.' } },
    });
  });
});
