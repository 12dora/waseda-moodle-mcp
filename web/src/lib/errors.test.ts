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
