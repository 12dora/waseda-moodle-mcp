import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/core/crypto';
import { RateLimited } from '../../src/core/errors';
import {
  API_KEY_PATTERN,
  clearSessionCookieHeader,
  clientIp,
  loadSession,
  memoryRateLimit,
  rateLimit,
  readSessionCookie,
  registrationPolicy,
  resetRateLimitMemory,
  resolveApiKey,
  SESSION_COOKIE,
  SESSION_TOUCH_MS,
  SESSION_TTL_MS,
  sessionCookieHeader,
  startSession,
} from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';

const SECRET = `wmm_${'A1b2C3d4E5'.repeat(4)}`; // wmm_ + 40 base62

describe('session cookie', () => {
  it('uses the __Host- prefix and the required attributes', () => {
    const h = sessionCookieHeader('abc');
    expect(h.startsWith(`${SESSION_COOKIE}=abc;`)).toBe(true);
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_TTL_MS / 1000}`]) {
      expect(h).toContain(attr);
    }
    expect(h).not.toContain('Domain');
    expect(clearSessionCookieHeader()).toContain('Max-Age=0');
  });

  it('reads the cookie among others and ignores lookalikes', () => {
    const req = (cookie?: string) => new Request('https://x.test/', { headers: cookie ? { Cookie: cookie } : {} });
    expect(readSessionCookie(req(`a=1; ${SESSION_COOKIE}=tok_en; b=2`))).toBe('tok_en');
    expect(readSessionCookie(req(`x${SESSION_COOKIE}=nope`))).toBeNull();
    expect(readSessionCookie(req(`${SESSION_COOKIE}=`))).toBeNull();
    expect(readSessionCookie(req())).toBeNull();
  });
});

describe('sessions (D1)', () => {
  let store: D1Store;
  let userId: number;
  const deferred: Promise<unknown>[] = [];
  const defer = (p: Promise<unknown>) => void deferred.push(p);

  beforeEach(async () => {
    deferred.length = 0;
    store = createD1Store(createTestD1().db);
    userId = (await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' })).id;
  });

  it('stores only the hash of the cookie value and loads user + session', async () => {
    const { cookieValue } = await startSession(store, userId, 'UA/1', 1_000_000);
    expect(await store.getSession(cookieValue)).toBeNull(); // raw value is not a key
    const hash = await sha256Hex(cookieValue);
    expect(await store.getSession(hash)).toMatchObject({ userId, expiresAt: 1_000_000 + SESSION_TTL_MS });

    const loaded = await loadSession(store, cookieValue, defer, 1_000_000 + 1000);
    expect(loaded?.user.id).toBe(userId);
    expect(loaded?.sessionHash).toBe(hash);
    expect(loaded?.touched).toBe(false);
    expect(deferred).toHaveLength(0);
  });

  it('slides the expiry only when the session is stale', async () => {
    const { cookieValue } = await startSession(store, userId, null, 1_000_000);
    const later = 1_000_000 + SESSION_TOUCH_MS + 1;
    const loaded = await loadSession(store, cookieValue, defer, later);
    expect(loaded?.touched).toBe(true);
    await Promise.all(deferred);
    expect(await store.getSession(await sha256Hex(cookieValue))).toMatchObject({
      lastSeenAt: later,
      expiresAt: later + SESSION_TTL_MS,
    });
    expect((await store.getUser(userId))?.lastSeenAt).toBe(later);
  });

  it('rejects unknown and expired sessions (and removes the expired row)', async () => {
    expect(await loadSession(store, 'nonexistent', defer)).toBeNull();
    const { cookieValue } = await startSession(store, userId, null, 1_000_000);
    expect(await loadSession(store, cookieValue, defer, 1_000_000 + SESSION_TTL_MS + 1)).toBeNull();
    await Promise.all(deferred);
    expect(await store.getSession(await sha256Hex(cookieValue))).toBeNull();
  });
});

describe('API keys', () => {
  let store: D1Store;
  let userId: number;

  beforeEach(async () => {
    store = createD1Store(createTestD1().db);
    userId = (await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' })).id;
    await store.createApiKey({
      id: 'key_1',
      userId,
      name: 'laptop',
      prefix: SECRET.slice(0, 8),
      keyHash: await sha256Hex(SECRET),
      scopes: ['moodle:write'], // legacy row without read: read is implied
      createdAt: 1,
      lastUsedAt: null,
      revokedAt: null,
    });
  });

  it('matches the key format', () => {
    expect(API_KEY_PATTERN.test(SECRET)).toBe(true);
    expect(API_KEY_PATTERN.test('wmm_short')).toBe(false);
    expect(API_KEY_PATTERN.test('a:b:c')).toBe(false);
  });

  it('resolves a valid key to props and touches it at most once an hour', async () => {
    const deferred: Promise<unknown>[] = [];
    const defer = (p: Promise<unknown>) => void deferred.push(p);
    const now = 10_000_000;
    const props = await resolveApiKey(store, SECRET, defer, now);
    expect(props).toEqual({ userId, scopes: ['moodle:read', 'moodle:write'], source: 'API key: laptop' });
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect((await store.getApiKeyByHash(await sha256Hex(SECRET)))?.lastUsedAt).toBe(now);

    await resolveApiKey(store, SECRET, defer, now + 60_000);
    expect(deferred).toHaveLength(1); // within the hour: no write
    await resolveApiKey(store, SECRET, defer, now + 3_600_001);
    expect(deferred).toHaveLength(2);
  });

  it('touches inline when no defer is available', async () => {
    await resolveApiKey(store, SECRET, undefined, 5_000);
    expect((await store.getApiKeyByHash(await sha256Hex(SECRET)))?.lastUsedAt).toBe(5_000);
  });

  it('rejects unknown, malformed and revoked keys', async () => {
    expect(await resolveApiKey(store, `wmm_${'z'.repeat(40)}`)).toBeNull();
    expect(await resolveApiKey(store, 'not-a-key')).toBeNull();
    await store.revokeApiKey(userId, 'key_1', 9);
    expect(await resolveApiKey(store, SECRET)).toBeNull();
  });
});

describe('registration policy', () => {
  const env = (registration: string, allowed = '') =>
    ({ REGISTRATION: registration, ALLOWED_MOODLE_USERIDS: allowed }) as unknown as Env;

  it('allowlist admits only listed ids', () => {
    const allow = registrationPolicy(env('allowlist', '1001, 1002;1003'));
    expect(allow(1001)).toBe(true);
    expect(allow(1003)).toBe(true);
    expect(allow(1004)).toBe(false);
  });

  it('empty or unknown mode behaves like allowlist; open admits everyone', () => {
    expect(registrationPolicy(env('allowlist'))(1)).toBe(false);
    expect(registrationPolicy(env('weird', '1'))(2)).toBe(false);
    expect(registrationPolicy(env('open'))(2)).toBe(true);
    expect(registrationPolicy(env(' OPEN '))(2)).toBe(true);
  });
});

describe('rate limits', () => {
  it('memoryRateLimit throws after the limit and resets with the window', () => {
    const now = 1_000;
    for (let i = 0; i < 3; i++) memoryRateLimit('t1', 3, 1000, now);
    expect(() => memoryRateLimit('t1', 3, 1000, now)).toThrow(RateLimited);
    expect(() => memoryRateLimit('t1', 3, 1000, now + 1001)).not.toThrow();
  });

  it('rateLimit counts in D1 per key and window, and never touches KV', async () => {
    const store = createD1Store(createTestD1().db);
    const rule = { key: 'k-a', limit: 3, windowMs: 1000 };
    for (let i = 0; i < 3; i++) await rateLimit(store, rule, 10_000);
    await expect(rateLimit(store, rule, 10_500)).rejects.toBeInstanceOf(RateLimited);
    // other keys are independent
    await expect(rateLimit(store, { ...rule, key: 'k-b' }, 10_500)).resolves.toBeUndefined();
    // a new window starts from zero
    for (let i = 0; i < 3; i++) await rateLimit(store, rule, 11_001);
    await expect(rateLimit(store, rule, 11_100)).rejects.toBeInstanceOf(RateLimited);
  });

  it('rateLimit fails open when storage breaks', async () => {
    const broken = {
      hitRateLimit: async () => {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Store;
    await expect(rateLimit(broken, { key: 'x', limit: 0, windowMs: 1000 })).resolves.toBeUndefined();
  });

  describe('in-isolate pre-check', () => {
    /** A store whose D1 counter is scripted per call; records how often D1 was hit. */
    const scripted = (answer: (call: number) => number | Error) => {
      const state = { calls: 0 };
      const store = {
        hitRateLimit: async () => {
          const r = answer(++state.calls);
          if (r instanceof Error) throw r;
          return r;
        },
      } as unknown as D1Store;
      return { store, state };
    };
    const rule = { key: 'pre-k', limit: 2, windowMs: 600_000 };

    beforeEach(() => resetRateLimitMemory());

    it('blockedKeys short-circuit refuses without calling D1, with the same 429 error', async () => {
      const { store, state } = scripted(() => 3);
      const first = await rateLimit(store, rule, 1_000).catch((e) => e);
      expect(first).toBeInstanceOf(RateLimited);
      expect(state.calls).toBe(1);
      const second = await rateLimit(store, rule, 2_000).catch((e) => e);
      expect(state.calls).toBe(1);
      expect(second).toBeInstanceOf(RateLimited);
      expect(second.code).toBe(first.code);
      expect(second.message).toBe(first.message);
    });

    it('the 2×limit memory path refuses without calling D1 (D1 down, failing open)', async () => {
      const { store, state } = scripted(() => new Error('D1 unavailable'));
      for (let i = 0; i < 4; i++) await expect(rateLimit(store, rule, 1_000 + i)).resolves.toBeUndefined();
      expect(state.calls).toBe(4);
      const err = await rateLimit(store, rule, 1_010).catch((e) => e);
      expect(err).toBeInstanceOf(RateLimited);
      expect(err.code).toBe('rate_limited');
      expect(state.calls).toBe(4);
      await expect(rateLimit(store, rule, 1_000 + rule.windowMs)).resolves.toBeUndefined();
      expect(state.calls).toBe(5);
    });

    it('does not count requests D1 rejected, so it never blocks after D1 allows again', async () => {
      // D1 rejects 10 times in a row across blocked-key expiries, then its window resets.
      const { store, state } = scripted((call) => (call <= 10 ? 3 : 1));
      let now = 1_000;
      for (let i = 0; i < 10; i++) {
        await expect(rateLimit(store, rule, now)).rejects.toBeInstanceOf(RateLimited);
        now += rule.windowMs / 10; // blockedKeys entry expires, D1 is asked again
      }
      expect(state.calls).toBe(10);
      await expect(rateLimit(store, rule, now)).resolves.toBeUndefined();
      await expect(rateLimit(store, rule, now + 1)).resolves.toBeUndefined();
    });

    it('rotating-IP churn does not reset the MCP per-user counters', async () => {
      const { store } = scripted(() => 1);
      const now = Date.now();
      memoryRateLimit('mcp:user-1', 2, 60_000, now);
      memoryRateLimit('mcp:user-1', 2, 60_000, now);
      for (let i = 0; i < 2500; i++) {
        await rateLimit(store, { key: `ext:ip:10.0.${i >> 8}.${i & 255}`, limit: 5, windowMs: 60_000 }, now);
      }
      expect(() => memoryRateLimit('mcp:user-1', 2, 60_000, now)).toThrow(RateLimited);
    });
  });

  it('clientIp prefers CF-Connecting-IP', () => {
    const r = (h: Record<string, string>) => new Request('https://x.test/', { headers: h });
    expect(clientIp(r({ 'CF-Connecting-IP': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(r({ 'X-Forwarded-For': '198.51.100.1, 10.0.0.1' }))).toBe('198.51.100.1');
    expect(clientIp(r({}))).toBe('unknown');
  });
});
