import { describe, expect, it } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import { launchUrl, MOODLE_URL, md5Hex, parseLaunch } from '../../src/core/moodle/launch';

// Synthetic values only.
const TOKEN = '0123456789abcdef0123456789abcdef';
const PRIVATE = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2';
const PASSPORT = 'p4ssp0rt';

const b64 = (s: string) => btoa(s);
const payload = (sig: string, priv?: string) => b64(`${sig}:::${TOKEN}${priv ? `:::${priv}` : ''}`);

describe('md5Hex', () => {
  it('matches the RFC 1321 vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
    expect(md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe(
      '57edf4a22be3c955ac49da2e2107b67a',
    );
  });
});

describe('launchUrl', () => {
  it('builds the confirmed=1 URL', () => {
    expect(launchUrl('wmm')).toBe(
      `${MOODLE_URL}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=wmm&urlscheme=moodlemobile&confirmed=1`,
    );
    expect(launchUrl('a b', false)).not.toContain('confirmed');
    expect(launchUrl('a b', false)).toContain('passport=a%20b');
  });
});

describe('parseLaunch', () => {
  const sig = md5Hex(MOODLE_URL + PASSPORT);

  it('parses the full ltgopenlmsapp URL with private token and verifies the signature', () => {
    const r = parseLaunch(`ltgopenlmsapp://token=${payload(sig, PRIVATE)}`, PASSPORT);
    expect(r).toEqual({ token: TOKEN, privateToken: PRIVATE, signatureOk: true });
  });

  it('works without a private token and flags a wrong passport', () => {
    const url = `ltgopenlmsapp://token=${payload(sig)}`;
    expect(parseLaunch(url, PASSPORT)).toEqual({ token: TOKEN, privateToken: null, signatureOk: true });
    expect(parseLaunch(url, 'other').signatureOk).toBe(false);
    expect(parseLaunch(url).signatureOk).toBeNull();
  });

  it('accepts any scheme, quotes, whitespace and a trailing slash-less form', () => {
    const p = payload(sig, PRIVATE);
    expect(parseLaunch(`  "moodlemobile://token=${p}"\n`).token).toBe(TOKEN);
    expect(parseLaunch(`'ltgopenlmsapp://token=${p}'`).token).toBe(TOKEN);
    expect(parseLaunch(`token=${p}`).token).toBe(TOKEN);
  });

  it('accepts URL-encoded variants', () => {
    const p = payload(sig, PRIVATE);
    expect(parseLaunch(`ltgopenlmsapp://token=${encodeURIComponent(p)}`).token).toBe(TOKEN);
    expect(parseLaunch(encodeURIComponent(`ltgopenlmsapp://token=${p}`)).token).toBe(TOKEN);
    expect(parseLaunch(encodeURIComponent(p)).privateToken).toBe(PRIVATE);
  });

  it('accepts the bare base64 payload (padded or not, url-safe alphabet)', () => {
    const p = payload(sig, PRIVATE);
    expect(parseLaunch(p).token).toBe(TOKEN);
    expect(parseLaunch(p.replace(/=+$/, '')).token).toBe(TOKEN);
    expect(parseLaunch(p.replace(/\+/g, '-').replace(/\//g, '_')).token).toBe(TOKEN);
  });

  it('accepts a bare 32-hex token', () => {
    expect(parseLaunch(TOKEN)).toEqual({ token: TOKEN, privateToken: null, signatureOk: null });
    expect(parseLaunch(`"${TOKEN.toUpperCase()}"`).token).toBe(TOKEN);
  });

  it('rejects anything else with a safe message', () => {
    for (const bad of [
      '',
      '   ',
      'hello',
      'ltgopenlmsapp://token=',
      'ltgopenlmsapp://token=%%%',
      b64('nothing here'),
      b64(`sig:::short`),
      'x'.repeat(5000),
    ]) {
      expect(() => parseLaunch(bad)).toThrow(InvalidInput);
    }
    try {
      parseLaunch(`ltgopenlmsapp://token=${b64('abc:::zzzz')}`);
    } catch (e) {
      expect((e as Error).message).not.toContain('zzzz');
    }
  });
});
