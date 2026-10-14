import { describe, expect, it } from 'vitest';
import { buildConnectUrl, buildLaunchUrl, extractLaunchHref, normalizeServiceUrl, randomPassport } from './capture.js';

describe('randomPassport', () => {
  it('returns 16 hex chars and varies', () => {
    const a = randomPassport();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(randomPassport()).not.toBe(a);
  });
});

describe('buildLaunchUrl', () => {
  it('builds confirmed launch URL', () => {
    const u = new URL(buildLaunchUrl('abc123'));
    expect(u.origin + u.pathname).toBe('https://wsdmoodle.waseda.jp/admin/tool/mobile/launch.php');
    expect(u.searchParams.get('service')).toBe('moodle_mobile_app');
    expect(u.searchParams.get('passport')).toBe('abc123');
    expect(u.searchParams.get('confirmed')).toBe('1');
  });
  it('rejects bad passports', () => {
    expect(() => buildLaunchUrl('')).toThrow();
    expect(() => buildLaunchUrl('a&b')).toThrow();
  });
});

describe('extractLaunchHref', () => {
  it('finds id before href', () => {
    expect(extractLaunchHref('<p><a id="launchapp" class="btn" href="ltgopenlmsapp://token=QUJD">x</a>')).toBe(
      'ltgopenlmsapp://token=QUJD',
    );
  });
  it('finds href before id and decodes &amp;', () => {
    expect(extractLaunchHref('<a href="ltgopenlmsapp://token=QUJD&amp;x=1" id="launchapp">x</a>')).toBe(
      'ltgopenlmsapp://token=QUJD&x=1',
    );
  });
  it('returns null for login pages and junk', () => {
    expect(extractLaunchHref('<form action="/login/index.php"></form>')).toBeNull();
    expect(extractLaunchHref('<a id="launchapp" href="https://evil.example/">x</a>')).toBeNull();
    expect(extractLaunchHref(undefined)).toBeNull();
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
    expect(url).not.toMatch(/launch|token/);
  });
});
