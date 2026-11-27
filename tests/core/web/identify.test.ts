import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, NeedsReconnect } from '../../../src/core/errors';
import { identifySession, normalizeSessionCookie, parseIdentity } from '../../../src/core/moodle/web/identify';

const BASE = 'https://wsdmoodle.waseda.jp';
const VALUE = 'abcdefghij0123456789xyz';
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/web/${name}`, import.meta.url), 'utf8');

describe('normalizeSessionCookie', () => {
  it.each([
    [VALUE],
    [`MoodleSession=${VALUE}`],
    [`  MoodleSession=${VALUE}; path=/; secure; HttpOnly `],
    [`Cookie: _ga=GA1.2.3; MoodleSession=${VALUE}; other=1`],
    [`cookie: other=1;MoodleSession=${VALUE}`],
  ])('accepts %s', (input) => {
    expect(normalizeSessionCookie(input)).toBe(`MoodleSession=${VALUE}`);
  });

  it.each([[''], ['short'], [`MoodleSession=bad value ${VALUE}`], ['x'.repeat(129)], [`OtherCookie=${VALUE}`]])(
    'refuses %s',
    (input) => {
      expect(() => normalizeSessionCookie(input)).toThrow(InvalidInput);
      expect(() => normalizeSessionCookie(input)).toThrow('Paste the value of the MoodleSession cookie.');
    },
  );
});

describe('parseIdentity', () => {
  it('reads the user, sesskey, language and full name (ja)', () => {
    expect(parseIdentity(fixture('core-profile-ja.html'))).toEqual({
      moodleUserId: 7001,
      fullname: '山田 太郎',
      lang: 'ja',
      sesskey: 'Prof1leKey',
    });
  });

  it('reads the profile page in English', () => {
    expect(parseIdentity(fixture('core-profile-en.html'))).toEqual({
      moodleUserId: 7002,
      fullname: 'Taro & Yamada',
      lang: 'en',
      sesskey: 'EnKey12345',
    });
  });

  it('null for a page without a signed-in user', () => {
    expect(parseIdentity(fixture('core-login-ja.html'))).toBeNull();
    expect(parseIdentity('<html></html>')).toBeNull();
  });
});

describe('identifySession', () => {
  const cookie = `MoodleSession=${VALUE}`;

  it('GETs the profile with the cookie and returns the identity (with a rotated cookie)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(fixture('core-profile-ja.html'), {
          headers: { 'content-type': 'text/html', 'set-cookie': 'MoodleSession=rotated0123456789abcdef; path=/' },
        }),
    );
    const out = await identifySession(fetchMock as unknown as typeof fetch, cookie);
    expect(out).toEqual({
      moodleUserId: 7001,
      fullname: '山田 太郎',
      lang: 'ja',
      sesskey: 'Prof1leKey',
      cookie: 'MoodleSession=rotated0123456789abcdef',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/user/profile.php`);
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).Cookie).toBe(cookie);
  });

  it('a login redirect -> NeedsReconnect with the paste wording', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 303, headers: { Location: `${BASE}/login/index.php` } }),
    );
    const e = await identifySession(fetchMock as unknown as typeof fetch, cookie).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NeedsReconnect);
    expect((e as Error).message).toBe('The Moodle session has ended. Sign in to Moodle again and copy a new cookie.');
  });

  it('uses at most two requests', async () => {
    const loop = { status: 303, headers: { Location: '/user/profile.php' } };
    const fetchMock = vi.fn(async () => new Response(null, loop));
    await expect(identifySession(fetchMock as unknown as typeof fetch, cookie)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a page without the user -> MoodleError', async () => {
    const fetchMock = vi.fn(async () => new Response('<html><body id="page-x"></body></html>'));
    await expect(identifySession(fetchMock as unknown as typeof fetch, cookie)).rejects.toBeInstanceOf(MoodleError);
  });
});
