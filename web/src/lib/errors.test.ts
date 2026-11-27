import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { DICTIONARIES, LANGS, type Translate, translate } from '../i18n/core';
import { en } from '../i18n/en';
import { errorText, serverMessageText } from './errors';

const t: Translate = (key, vars) => translate(en, key, vars);
const SUPERSEDED = 'Another action for the same target already ran. Prepare it again if you still need it.';

describe('serverMessageText', () => {
  it('keeps the server message for invalid_input', () => {
    const e = new ApiError(400, 'invalid_input', SUPERSEDED);
    expect(serverMessageText(e, t)).toBe(SUPERSEDED);
    expect(errorText(e, t)).toBe(en['error.invalid_input']);
  });

  it('falls back to the localized text otherwise', () => {
    expect(serverMessageText(new ApiError(400, 'invalid_input', 'HTTP 400'), t)).toBe(en['error.invalid_input']);
    expect(serverMessageText(new ApiError(403, 'forbidden', 'nope'), t)).toBe(en['error.forbidden']);
  });

  it('maps the mail decision refusals to their texts', () => {
    const say = (m: string) => serverMessageText(new ApiError(400, 'invalid_input', m), t);
    expect(say('The request changed. Reload and try again.')).toBe(en['mail.admin.refusal.changed']);
    expect(say('The request is not pending.')).toBe(en['mail.admin.refusal.changed']);
    expect(say('Mail access is not approved.')).toBe(en['mail.rejected']);
    expect(say('Operators are always approved.')).toBe(en['mail.admin.refusal.operator']);
  });

  it('keeps unknown invalid_input text as sent', () => {
    expect(serverMessageText(new ApiError(400, 'invalid_input', 'Something else.'), t)).toBe('Something else.');
  });

  it('localizes the known refusals in ja and zh-CN', () => {
    const messages = [
      SUPERSEDED,
      'This action has expired. Prepare it again.',
      'This action was cancelled.',
      'This action is already running.',
      'Another action for the same target is running.',
      'The request changed. Reload and try again.',
      'The request is not pending.',
      'Mail access is not approved.',
      'Operators are always approved.',
    ];
    for (const lang of LANGS.filter((l) => l !== 'en')) {
      const tl: Translate = (key, vars) => translate(DICTIONARIES[lang], key, vars);
      for (const m of messages) {
        const text = serverMessageText(new ApiError(400, 'invalid_input', m), tl);
        expect(text, `${lang}: ${m}`).not.toBe(m);
        expect(text, `${lang}: ${m}`).not.toBe(DICTIONARIES[lang]['error.invalid_input']);
      }
    }
  });
});

describe('errorText next steps', () => {
  const body = (error: Record<string, unknown>) => ({ error });

  it('gives the rate-limit wait in minutes when the server sends it', () => {
    const waited = new ApiError(429, 'rate_limited', 'x', body({ code: 'rate_limited', retryAfter: 600 }));
    expect(errorText(waited, t)).toBe(translate(en, 'error.rate_limitedWait', { minutes: 10 }));
    expect(errorText(new ApiError(429, 'rate_limited', 'x'), t)).toBe(en['error.rate_limited']);
  });

  it("names Moodle's maintenance and its end when known", () => {
    const until = new ApiError(502, 'moodle_unavailable', 'x', body({ maintenance: true, until: '11/30 06:00' }));
    expect(errorText(until, t)).toContain('11/30 06:00');
    const plain = new ApiError(502, 'moodle_unavailable', 'x', body({ maintenance: true }));
    expect(errorText(plain, t)).toBe(en['error.moodle_maintenance']);
    expect(errorText(new ApiError(502, 'moodle_unavailable', 'x'), t)).toBe(en['error.moodle_unavailable']);
  });

  it('tells what to do next for the common codes in every language', () => {
    for (const lang of LANGS) {
      const d = DICTIONARIES[lang];
      for (const key of ['error.needs_reconnect', 'error.moodle_unavailable', 'error.budget_exceeded'] as const) {
        expect(d[key].split(/[.。]/).filter((s) => s.trim()).length, `${lang}:${key}`).toBeGreaterThan(1);
      }
    }
    expect(en['error.needs_reconnect']).toContain('extension');
    expect(en['error.needs_reconnect']).toContain('Connect page');
  });
});
