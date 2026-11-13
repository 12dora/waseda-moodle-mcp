import { beforeEach, describe, expect, it } from 'vitest';
import { usagePeriods } from '../../src/core/usage';
import { createApi } from '../../src/worker/api';
import { consoleFeature } from '../../src/worker/api/console-usage';
import {
  BACKGROUND_HEADER,
  resetRateLimitMemory,
  SESSION_COOKIE,
  SESSION_TOUCH_MS,
  startSession,
} from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { resetUsageMemory } from '../../src/worker/store/usage';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

const ORIGIN = 'https://wasemoodle.example.com';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));

const app = createApi();
let testD1: TestD1;
let env: Env;
let store: D1Store;
let userId: number;
let cookie: string;
let waits: Promise<unknown>[];
const execCtx = {
  waitUntil: (p: Promise<unknown>) => void waits.push(p),
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

async function call(path: string, opts: { cookie?: string; background?: boolean; method?: string } = {}) {
  const headers = new Headers({ 'CF-Connecting-IP': '198.51.100.7' });
  if (opts.cookie) headers.set('Cookie', opts.cookie);
  if (opts.background) headers.set(BACKGROUND_HEADER, '1');
  if (opts.method && opts.method !== 'GET') {
    headers.set('X-WMM', '1');
    headers.set('Origin', ORIGIN);
  }
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: opts.method, headers }), env, execCtx);
  await Promise.all(waits.splice(0));
  return res;
}

const counters = () =>
  testD1.sqlite
    .prepare(
      "SELECT period, metric, dim, value FROM usage_counts WHERE metric != 'signups' ORDER BY metric, period, dim",
    )
    .all() as { period: string; metric: string; dim: string; value: number }[];
const value = (metric: string, dim = '') =>
  counters()
    .filter((r) => r.metric === metric && r.dim === dim && r.period === usagePeriods(Date.now()).day)
    .reduce((n, r) => n + r.value, 0);

beforeEach(async () => {
  resetUsageMemory();
  resetRateLimitMemory();
  waits = [];
  testD1 = createTestD1();
  env = {
    DB: testD1.db,
    OAUTH_KV: new MemoryKV().asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: ORIGIN,
  } as Env;
  store = createD1Store(testD1.db);
  userId = (await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' })).id;
  await store.touchUser(userId, 1);
  // a session last seen long ago: a counted request would refresh it
  const old = Date.now() - 2 * SESSION_TOUCH_MS;
  cookie = `${SESSION_COOKIE}=${(await startSession(store, userId, null, old)).cookieValue}`;
});

describe('consoleFeature', () => {
  it('maps console API routes to the fixed feature vocabulary', () => {
    expect(consoleFeature('GET', '/api/me')).toBe('open');
    expect(consoleFeature('DELETE', '/api/me')).toBe('account');
    expect(consoleFeature('PATCH', '/api/settings')).toBe('settings');
    expect(consoleFeature('GET', '/api/due')).toBe('due');
    expect(consoleFeature('GET', '/api/courses/overview')).toBe('courses');
    expect(consoleFeature('GET', '/api/syllabus')).toBe('course_view');
    expect(consoleFeature('GET', '/api/courses')).toBe('course_selection');
    expect(consoleFeature('GET', '/api/actions')).toBe('approvals');
    expect(consoleFeature('POST', '/api/actions/act_1/approve')).toBe('approvals');
    expect(consoleFeature('DELETE', '/api/keys/key_1')).toBe('keys');
    expect(consoleFeature('DELETE', '/api/apps/g1')).toBe('apps');
    expect(consoleFeature('POST', '/api/calendar')).toBe('calendar');
    expect(consoleFeature('POST', '/api/oauth/requests/r1/approve')).toBe('consent');
    expect(consoleFeature('GET', '/api/admin/stats')).toBe('stats');
  });

  it('counts nothing outside the vocabulary', () => {
    for (const [method, path] of [
      ['GET', '/api/config'],
      ['POST', '/api/connect'],
      ['POST', '/api/logout'],
      ['POST', '/api/extension/refresh'],
      ['GET', '/api/actionsx'],
      ['GET', '/cal/abc.ics'],
    ] as const) {
      expect(consoleFeature(method, path)).toBeNull();
    }
  });
});

describe('console usage counting', () => {
  it('counts a user-initiated request as web activity, page and hour, and refreshes last-seen', async () => {
    expect((await call('/api/keys', { cookie })).status).toBe(200);
    expect((await call('/api/keys', { cookie })).status).toBe(200);
    expect(value('page', 'keys')).toBe(2);
    expect(value('active_web')).toBe(1);
    expect(value('active_all')).toBe(1);
    expect(value('active')).toBe(0); // MCP activity is separate
    expect(counters().filter((r) => r.metric === 'hour_web')).toEqual([expect.objectContaining({ value: 2 })]);
    expect((await store.getUser(userId))?.lastSeenAt).not.toBe(1);
  });

  it('ignores background requests: no activity, no page count, no last-seen or session refresh', async () => {
    const res = await call('/api/actions?status=pending&limit=100', { cookie, background: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(counters()).toEqual([]);
    expect((await store.getUser(userId))?.lastSeenAt).toBe(1);

    // the same request made by the user counts
    await call('/api/actions?status=pending&limit=100', { cookie });
    expect(value('page', 'approvals')).toBe(1);
    expect((await store.getUser(userId))?.lastSeenAt).not.toBe(1);
  });

  it('counts nothing without a session', async () => {
    expect((await call('/api/keys')).status).toBe(401);
    expect((await call('/api/config')).status).toBe(200);
    expect(counters()).toEqual([]);
  });

  it('counts a request whose handler fails, once its session was accepted', async () => {
    expect((await call('/api/keys/key_missing', { cookie, method: 'DELETE' })).status).toBeGreaterThanOrEqual(400);
    expect(value('page', 'keys')).toBe(1);
  });
});
