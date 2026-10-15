import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/core/crypto';
import { MoodleUnavailable, NeedsReconnect } from '../../src/core/errors';
import { createApi } from '../../src/worker/api';
import { resetRateLimitMemory, SESSION_COOKIE, startSession } from '../../src/worker/auth';
import { buildFeed } from '../../src/worker/calendar/feed';
import { resetCalendarMisses } from '../../src/worker/calendar/routes';
import { FEED_CACHE_MS, MAX_STALE_MS } from '../../src/worker/calendar/serve';
import type { Env } from '../../src/worker/env';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

vi.mock('../../src/worker/calendar/feed', async (importActual) => ({
  ...(await importActual<typeof import('../../src/worker/calendar/feed')>()),
  buildFeed: vi.fn(),
}));

const ORIGIN = 'https://wasemoodle.example.com';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 11)));
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const TOKEN_PATH = /^\/cal\/[A-Za-z0-9_-]{43}\.ics$/;

const app = createApi();
let testD1: TestD1;
let env: Env;
let store: D1Store;
let cookie: string;
let ipCounter = 0;
/** Promises handed to waitUntil: work that runs after the response. */
let waits: Promise<unknown>[] = [];
const execCtx = {
  waitUntil: (p: Promise<unknown>) => void waits.push(p),
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;
const settled = async () => void (await Promise.all(waits.splice(0)));

function makeEnv(): Env {
  testD1 = createTestD1();
  return {
    DB: testD1.db,
    OAUTH_KV: new MemoryKV().asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: ORIGIN,
    REGISTRATION: 'allowlist',
    ALLOWED_MOODLE_USERIDS: '1001',
  } as Env;
}

async function call(
  path: string,
  init: RequestInit & { cookie?: string; ip?: string; defer?: boolean } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('Cookie', init.cookie);
  if (init.method && init.method !== 'GET') {
    headers.set('X-WMM', '1');
    headers.set('Origin', ORIGIN);
  }
  ipCounter = (ipCounter % 250) + 1;
  headers.set('CF-Connecting-IP', init.ip ?? `198.51.100.${ipCounter}`);
  return app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, init.defer ? execCtx : undefined);
}

/** Creates (or rotates) the feed through the API and returns the feed path. */
async function enable(): Promise<string> {
  const res = await call('/api/calendar', { method: 'POST', cookie });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  expect(url.startsWith(ORIGIN)).toBe(true);
  return url.slice(ORIGIN.length);
}

const feedRow = () =>
  testD1.sqlite.prepare('SELECT * FROM calendar_feeds').get() as {
    token_hash: string;
    last_fetch_at: number | null;
    cache_ics: string | null;
    cache_at: number | null;
  };

const ageCache = (ms: number) => testD1.sqlite.prepare('UPDATE calendar_feeds SET cache_at = cache_at - ?').run(ms);
const rateRows = () => testD1.sqlite.prepare("SELECT key, count FROM rate_limits WHERE key LIKE 'cal:%'").all();

beforeEach(async () => {
  waits = [];
  resetRateLimitMemory();
  resetCalendarMisses();
  env = makeEnv();
  store = createD1Store(testD1.db);
  const user = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
  cookie = `${SESSION_COOKIE}=${(await startSession(store, user.id, null)).cookieValue}`;
  vi.mocked(buildFeed).mockReset();
  vi.mocked(buildFeed).mockResolvedValue(ICS);
});

afterEach(() => vi.restoreAllMocks());

describe('/api/calendar', () => {
  it('requires a session', async () => {
    expect((await call('/api/calendar')).status).toBe(401);
    expect((await call('/api/calendar', { method: 'POST' })).status).toBe(401);
    expect((await call('/api/calendar', { method: 'DELETE' })).status).toBe(401);
  });

  it('reports a disabled feed, then an enabled one after creation', async () => {
    expect(await (await call('/api/calendar', { cookie })).json()).toEqual({
      enabled: false,
      createdAt: null,
      lastFetchAt: null,
    });
    await enable();
    const status = (await (await call('/api/calendar', { cookie })).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ enabled: true, lastFetchAt: null });
    expect(status.createdAt).toMatch(/\+09:00$/);
  });

  it('creates a 32-byte token URL and stores only its SHA-256', async () => {
    const path = await enable();
    expect(path).toMatch(TOKEN_PATH);
    const token = path.slice('/cal/'.length, -'.ics'.length);
    expect(feedRow().token_hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(testD1.sqlite.prepare('SELECT * FROM calendar_feeds').all())).not.toContain(token);
  });

  it('rotating makes the previous URL stop working at once', async () => {
    const first = await enable();
    expect((await call(first)).status).toBe(200);

    const second = await enable();
    expect(second).not.toBe(first);
    expect((await call(first)).status).toBe(404);
    expect((await call(second)).status).toBe(200);
  });

  it('revoking deletes the feed, answers 404 on its URL and is repeatable', async () => {
    const path = await enable();
    expect((await call('/api/calendar', { method: 'DELETE', cookie })).status).toBe(200);
    expect((await call(path)).status).toBe(404);
    expect(await (await call('/api/calendar', { cookie })).json()).toMatchObject({ enabled: false });
    expect((await call('/api/calendar', { method: 'DELETE', cookie })).status).toBe(200);
  });
});

describe('GET /cal/<token>.ics', () => {
  it('serves the feed as text/calendar and never lets it be indexed or cached publicly', async () => {
    const res = await call(await enable());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toContain('private');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await res.text()).toBe(ICS);
  });

  it('builds the feed for the token owner with read scope only', async () => {
    await call(await enable());
    expect(buildFeed).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(buildFeed).mock.calls[0]?.[0];
    expect(ctx?.user.moodleUserId).toBe(1001);
    expect(ctx?.scopes).toEqual(['moodle:read']);
    expect(ctx?.source).toBe('Calendar feed');
  });

  it('caches the feed in D1 for 30 minutes and stamps each fetch', async () => {
    const path = await enable();
    await call(path);
    const first = feedRow();
    expect(first.cache_ics).toBe(ICS);
    expect(first.last_fetch_at).toBe(first.cache_at);

    vi.mocked(buildFeed).mockResolvedValue('BEGIN:VCALENDAR\r\nX-NEW:1\r\nEND:VCALENDAR\r\n');
    expect(await (await call(path)).text()).toBe(ICS);
    expect(buildFeed).toHaveBeenCalledTimes(1);
    expect(feedRow().cache_at).toBe(first.cache_at);
    expect(feedRow().last_fetch_at).toBeGreaterThanOrEqual(first.last_fetch_at ?? 0);

    testD1.sqlite.prepare('UPDATE calendar_feeds SET cache_at = cache_at - ?').run(FEED_CACHE_MS + 1000);
    expect(await (await call(path)).text()).toContain('X-NEW:1');
    expect(buildFeed).toHaveBeenCalledTimes(2);
  });

  it('answers 404 with one body for unknown, malformed and revoked tokens, without building anything', async () => {
    const path = await enable();
    const unknown = `/cal/${'A'.repeat(43)}.ics`;
    const bodies: unknown[] = [];
    for (const p of [unknown, '/cal/short.ics', `/cal/${'A'.repeat(43)}.txt`, `${path}x`, '/cal/.ics']) {
      const res = await call(p);
      expect(res.status).toBe(404);
      bodies.push(await res.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(buildFeed).not.toHaveBeenCalled();
  });

  it('limits the requests that build the feed to 12 per hour through D1', async () => {
    const path = await enable();
    for (let i = 0; i < 12; i++) {
      ageCache(FEED_CACHE_MS + 1000); // no context to defer to, so every request rebuilds inline
      expect((await call(path)).status).toBe(200);
    }
    ageCache(FEED_CACHE_MS + 1000);
    const limited = await call(path);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('3600');
    expect(buildFeed).toHaveBeenCalledTimes(12);
  });

  it('limits the requests answered from the cache to 12 per hour per isolate, with no D1 counter write', async () => {
    const path = await enable();
    expect((await call(path)).status).toBe(200); // builds: the one D1 counter write
    for (let i = 0; i < 12; i++) expect((await call(path)).status).toBe(200);
    const limited = await call(path);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('3600');
    expect(buildFeed).toHaveBeenCalledTimes(1);
    expect(rateRows()).toEqual([expect.objectContaining({ count: 1 })]);
  });

  it('throttles an IP that keeps guessing tokens, but not other IPs', async () => {
    const guess = (ip: string) => call(`/cal/${'B'.repeat(43)}.ics`, { ip });
    for (let i = 0; i < 30; i++) expect((await guess('203.0.113.9')).status).toBe(404);
    expect((await guess('203.0.113.9')).status).toBe(429);
    expect((await guess('203.0.113.10')).status).toBe(404);
  });

  it('refuses an over-limit IP before any D1 lookup', async () => {
    const ip = '203.0.113.30';
    for (let i = 0; i < 30; i++) await call(`/cal/${'D'.repeat(43)}.ics`, { ip });
    const prepare = vi.spyOn(env.DB, 'prepare');
    const res = await call(`/cal/${'D'.repeat(43)}.ics`, { ip });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not count valid fetches against the guessing limit of a shared IP', async () => {
    const path = await enable();
    for (let i = 0; i < 5; i++) expect((await call(path, { ip: '203.0.113.20' })).status).toBe(200);
    expect((await call(`/cal/${'C'.repeat(43)}.ics`, { ip: '203.0.113.20' })).status).toBe(404);
  });
});

describe('when the feed cannot be built', () => {
  it('answers 503 with Retry-After and a short reason when there is no earlier copy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(buildFeed).mockRejectedValue(new MoodleUnavailable());
    const res = await call(await enable());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1800');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).not.toBe('');
  });

  it('answers 503 with a generic text for unexpected errors (nothing leaks)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(buildFeed).mockRejectedValue(new Error('secret internal detail'));
    const res = await call(await enable());
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('The calendar is temporarily unavailable.');
  });

  it('serves the previous copy when a rebuild fails, and retries on the next request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const path = await enable();
    await call(path);
    ageCache(FEED_CACHE_MS + 1000);
    const staleAt = feedRow().cache_at;

    vi.mocked(buildFeed).mockRejectedValue(new MoodleUnavailable());
    const stale = await call(path);
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe(ICS);
    expect(feedRow().cache_at).toBe(staleAt); // still stale: the next request tries again

    vi.mocked(buildFeed).mockResolvedValue('BEGIN:VCALENDAR\r\nX-FRESH:1\r\nEND:VCALENDAR\r\n');
    expect(await (await call(path)).text()).toContain('X-FRESH:1');
  });

  it('does not serve a copy older than 24 hours in place of a failed rebuild: 503 with Retry-After', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const path = await enable();
    await call(path);
    ageCache(MAX_STALE_MS + 1000);
    vi.mocked(buildFeed).mockRejectedValue(new MoodleUnavailable());
    const res = await call(path);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1800');
  });
});

describe('a lost Moodle credential', () => {
  const noticeOf = async (res: Response) => (await res.text()).replace(/\r\n /g, '');

  it('is answered with a valid ICS telling the user to reconnect, not with an error', async () => {
    vi.mocked(buildFeed).mockRejectedValue(new NeedsReconnect());
    const res = await call(await enable());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    const text = await noticeOf(res);
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(text).toContain('SUMMARY:Waseda Moodle: reconnect your account');
    expect(text).toContain(`URL:${ORIGIN}\r\n`);
    expect(text).toMatch(/DTSTART;VALUE=DATE:\d{8}\r\n/);
    expect(feedRow().cache_ics).toBeNull(); // not cached: the next request looks again
  });

  it('never falls back to the stale copy', async () => {
    const path = await enable();
    await call(path);
    ageCache(FEED_CACHE_MS + 1000);
    vi.mocked(buildFeed).mockRejectedValue(new NeedsReconnect());
    const text = await noticeOf(await call(path));
    expect(text).toContain('reconnect your account');
    expect(text).not.toBe(ICS);
    expect(feedRow().cache_ics).toBe(ICS);
  });

  it('replaces a stale copy by the notice when the background refresh finds the credential gone', async () => {
    const path = await enable();
    await call(path);
    ageCache(FEED_CACHE_MS + 1000);
    vi.mocked(buildFeed).mockRejectedValue(new NeedsReconnect());
    expect(await (await call(path, { defer: true })).text()).toBe(ICS); // served at once
    await settled();
    expect(feedRow().cache_ics).toContain('reconnect your account');
    expect(await noticeOf(await call(path, { defer: true }))).toContain('reconnect your account');
  });
});

describe('stale-while-revalidate', () => {
  const NEWER = 'BEGIN:VCALENDAR\r\nX-NEW:1\r\nEND:VCALENDAR\r\n';

  it('serves an old copy at once and rebuilds it after the response', async () => {
    const path = await enable();
    await call(path, { defer: true });
    await settled();
    ageCache(FEED_CACHE_MS + 1000);
    vi.mocked(buildFeed).mockResolvedValue(NEWER);

    const res = await call(path, { defer: true });
    expect(await res.text()).toBe(ICS);
    await settled();
    expect(buildFeed).toHaveBeenCalledTimes(2);
    expect(feedRow().cache_ics).toBe(NEWER);
    expect(await (await call(path, { defer: true })).text()).toBe(NEWER);
    expect(buildFeed).toHaveBeenCalledTimes(2);
  });

  it('does not rebuild a fresh copy', async () => {
    const path = await enable();
    await call(path, { defer: true });
    await settled();
    await call(path, { defer: true });
    await settled();
    expect(buildFeed).toHaveBeenCalledTimes(1);
  });

  it('keeps the old copy when the background rebuild fails (a killed rebuild never costs the response)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const path = await enable();
    await call(path, { defer: true });
    await settled();
    ageCache(FEED_CACHE_MS + 1000);
    const staleAt = feedRow().cache_at;
    vi.mocked(buildFeed).mockRejectedValue(new MoodleUnavailable());
    const res = await call(path, { defer: true });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ICS);
    await settled();
    expect(feedRow()).toMatchObject({ cache_ics: ICS, cache_at: staleAt });
  });

  it('builds inline when the copy is older than 24 hours, and when there is nothing to defer to', async () => {
    const path = await enable();
    await call(path, { defer: true });
    await settled();
    ageCache(MAX_STALE_MS + 1000);
    vi.mocked(buildFeed).mockResolvedValue(NEWER);
    expect(await (await call(path, { defer: true })).text()).toBe(NEWER);
    await settled();

    ageCache(FEED_CACHE_MS + 1000);
    vi.mocked(buildFeed).mockResolvedValue(ICS);
    expect(await (await call(path)).text()).toBe(ICS); // no execution context
  });
});

describe('bookkeeping writes', () => {
  const fetchAt = (at: number | null) => testD1.sqlite.prepare('UPDATE calendar_feeds SET last_fetch_at = ?').run(at);

  it('stamps last_fetch_at on a cache hit only when the stored value is missing or older than an hour', async () => {
    const path = await enable();
    await call(path);
    const recent = Date.now() - 10 * 60_000;
    fetchAt(recent);
    await call(path);
    expect(feedRow().last_fetch_at).toBe(recent);

    fetchAt(Date.now() - 2 * 3_600_000);
    await call(path);
    expect(feedRow().last_fetch_at).toBeGreaterThan(Date.now() - 60_000);

    fetchAt(null);
    await call(path);
    expect(feedRow().last_fetch_at).not.toBeNull();
  });

  it('runs the stamp after the response when it can', async () => {
    const path = await enable();
    await call(path);
    fetchAt(Date.now() - 2 * 3_600_000);
    await call(path, { defer: true });
    expect(waits.length).toBeGreaterThan(0);
    await settled();
    expect(feedRow().last_fetch_at).toBeGreaterThan(Date.now() - 60_000);
  });

  function failWrites(): void {
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('UPDATE calendar_feeds')) throw new Error('d1 write failed');
      return prepare(sql);
    });
  }

  it('serves a freshly built feed even when saving it fails', async () => {
    const path = await enable();
    failWrites();
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ICS);
    expect(feedRow().cache_ics).toBeNull();
  });

  it('serves a cached feed even when the last-fetch stamp fails', async () => {
    const path = await enable();
    await call(path);
    fetchAt(null);
    failWrites();
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ICS);
  });
});
