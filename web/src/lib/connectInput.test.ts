import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { pasteErrorKey, pasteRequest } from './connectInput';

const LAUNCH_URL = 'https://wsdmoodle.waseda.jp/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=wmm';
const SESSION = 'abcdefghij0123456789klmnop';
const LINK = 'ltgopenlmsapp://token=QUJD';

describe('pasteRequest', () => {
  it('asks for input when the field is blank', () => {
    expect(pasteRequest('', LAUNCH_URL)).toBeNull();
    expect(pasteRequest('  \n ', LAUNCH_URL)).toBeNull();
  });

  it('sends a bare cookie value as the session', () => {
    expect(pasteRequest(` ${SESSION}\n`, LAUNCH_URL)).toEqual({ session: SESSION, via: 'paste' });
  });

  it('sends a named cookie or a Cookie header as the session', () => {
    for (const value of [
      `MoodleSession=${SESSION}`,
      `MoodleSession=${SESSION}; path=/`,
      `Cookie: MoodleSession=${SESSION}`,
    ]) {
      expect(pasteRequest(value, LAUNCH_URL), value).toEqual({ session: value, via: 'paste' });
    }
  });

  it('sends a launch link with the passport of the launch page', () => {
    expect(pasteRequest(` ${LINK} `, LAUNCH_URL)).toEqual({ launch: LINK, via: 'paste', passport: 'wmm' });
  });

  it('recognises encoded, quoted and scheme-less launch links', () => {
    for (const value of ['ltgopenlmsapp%3A%2F%2Ftoken%3DQUJD', `"${LINK}"`, `<${LINK}>`, 'token=QUJD']) {
      expect(pasteRequest(value, LAUNCH_URL), value).toHaveProperty('launch', value);
    }
  });

  it('omits the passport when the launch URL cannot be read', () => {
    expect(pasteRequest(LINK, '')).toEqual({ launch: LINK, via: 'paste', passport: undefined });
  });
});

describe('pasteErrorKey', () => {
  const session = { session: SESSION, via: 'paste' } as const;
  const launch = { launch: LINK, via: 'paste' } as const;

  it('names what was refused and what to do', () => {
    expect(pasteErrorKey(new ApiError(400, 'invalid_input', 'x'), session)).toBe('connect.paste.notCookie');
    expect(pasteErrorKey(new ApiError(409, 'needs_reconnect', 'x'), session)).toBe('connect.paste.signedOut');
    expect(pasteErrorKey(new ApiError(403, 'forbidden', 'x'), session)).toBe('connect.paste.notAllowed');
    expect(pasteErrorKey(new ApiError(400, 'invalid_input', 'x'), launch)).toBe('connect.paste.badLaunch');
    expect(pasteErrorKey(new ApiError(403, 'forbidden', 'x'), launch)).toBe('connect.paste.notAllowed');
  });

  it('leaves other failures to the shared error text', () => {
    expect(pasteErrorKey(new ApiError(429, 'rate_limited', 'x'), session)).toBeNull();
    expect(pasteErrorKey(new ApiError(0, 'network', 'x'), launch)).toBeNull();
    expect(pasteErrorKey(new ApiError(409, 'account_switch', 'x'), session)).toBeNull();
    expect(pasteErrorKey(new Error('x'), session)).toBeNull();
  });
});
