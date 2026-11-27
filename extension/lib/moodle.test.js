import { describe, expect, it } from 'vitest';
import { buildConnectUrl, LOGIN_URL, MOODLE_ORIGIN, normalizeServiceUrl } from './moodle.js';

describe('Moodle addresses', () => {
  it('point at the Waseda Moodle sign-in page', () => {
    expect(MOODLE_ORIGIN).toBe('https://wsdmoodle.waseda.jp');
    expect(LOGIN_URL).toBe('https://wsdmoodle.waseda.jp/login/index.php');
  });
});

describe('normalizeServiceUrl', () => {
  it('keeps https origins only', () => {
    expect(normalizeServiceUrl(' https://svc.example.com/path/ ')).toBe('https://svc.example.com');
    expect(normalizeServiceUrl('http://svc.example.com')).toBeNull();
    expect(normalizeServiceUrl('not a url')).toBeNull();
  });
});

describe('buildConnectUrl', () => {
  it('carries only the handoff code', () => {
    const url = buildConnectUrl('https://s.example.com', 'hnd_a+b/c');
    expect(url).toBe('https://s.example.com/connect?code=hnd_a%2Bb%2Fc');
    expect(url).not.toMatch(/launch|token|session/);
  });
});
