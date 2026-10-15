import { beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../src/worker/api';
import { resetRateLimitMemory, SESSION_COOKIE, startSession } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

const ORIGIN = 'https://wasemoodle.example.com';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 11)));
const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;

const app = createApi();
let testD1: TestD1;
let env: Env;
let store: D1Store;
let adminCookie: string;
let userCookie: string;
let ipCounter = 0;

interface Day {
  day: string;
  active: number;
  calls: number;
  errors: number;
  newUsers: number;
}

interface Body {
  error: { code: string; message: string };
  generatedAt: number;
  days: number;
  users: { total: number; newInRange: number; activeToday: number; activeWeek: number; activeMonth: number };
  daily: Day[];
  tools: { name: string; calls: number; errors: number }[];
  clients: { name: string; calls: number; activeMonth: number }[];
}

function makeEnv(): Env {
  testD1 = createTestD1();
  return {
    DB: testD1.db,
    OAUTH_KV: new MemoryKV().asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: ORIGIN,
    REGISTRATION: 'allowlist',
    ALLOWED_MOODLE_USERIDS: '1001,1002',
    ADMIN_MOODLE_USERIDS: '1001',
  } as Env;
}

async function call(path: string, cookie?: string): Promise<Response> {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  ipCounter = (ipCounter % 250) + 1;
  headers.set('CF-Connecting-IP', `198.51.100.${ipCounter}`);
  return app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env);
}

/** JST calendar day 'YYYY-MM-DD' of an instant (fixed +09:00). */
const jst = (ms: number) => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
const dayAgo = (n: number) => jst(Date.now() - n * DAY_MS);

function count(period: string, metric: string, dim: string, value: number) {
  testD1.sqlite
    .prepare('INSERT INTO usage_counts (period, metric, dim, value) VALUES (?, ?, ?, ?)')
    .run(period, metric, dim, value);
}

function addUser(moodleUserId: number, createdAt: number) {
  testD1.sqlite
    .prepare(
      "INSERT INTO users (moodle_user_id, fullname, lang, settings, created_at) VALUES (?, 'Test User', 'en', '{}', ?)",
    )
    .run(moodleUserId, createdAt);
}

beforeEach(async () => {
  resetRateLimitMemory();
  env = makeEnv();
  store = createD1Store(testD1.db);
  const admin = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
  const user = await store.upsertUser({ moodleUserId: 1002, fullname: 'Hanako Sato', lang: 'ja' });
  adminCookie = `${SESSION_COOKIE}=${(await startSession(store, admin.id, null)).cookieValue}`;
  userCookie = `${SESSION_COOKIE}=${(await startSession(store, user.id, null)).cookieValue}`;
});

describe('GET /api/admin/stats access', () => {
  it('requires a session', async () => {
    const res = await call('/api/admin/stats');
    expect(res.status).toBe(401);
    expect(((await res.json()) as Body).error.code).toBe('unauthorized');
  });

  it('answers 404 not_found to non-operators', async () => {
    const res = await call('/api/admin/stats', userCookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('answers 404 to everybody when no operator is configured', async () => {
    env = { ...env, ADMIN_MOODLE_USERIDS: '' };
    expect((await call('/api/admin/stats', adminCookie)).status).toBe(404);
  });

  it('hides the bad-range error from non-operators', async () => {
    expect((await call('/api/admin/stats?days=5', userCookie)).status).toBe(404);
  });

  it('accepts several operators in the list', async () => {
    env = { ...env, ADMIN_MOODLE_USERIDS: '7; 1002 ,8' };
    expect((await call('/api/admin/stats', userCookie)).status).toBe(200);
  });
});

describe('GET /api/admin/stats days', () => {
  it('defaults to 30 and accepts 7, 30 and 90', async () => {
    expect(((await (await call('/api/admin/stats', adminCookie)).json()) as Body).days).toBe(30);
    for (const days of [7, 30, 90]) {
      const body = (await (await call(`/api/admin/stats?days=${days}`, adminCookie)).json()) as Body;
      expect(body.days).toBe(days);
      expect(body.daily).toHaveLength(days);
    }
  });

  it.each(['5', '0', '-7', '30.5', 'abc', '07', '365'])('rejects days=%s with 400', async (days) => {
    const res = await call(`/api/admin/stats?days=${days}`, adminCookie);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Body).error.code).toBe('invalid_input');
  });
});

describe('GET /api/admin/stats data', () => {
  it('returns zero-filled arrays, oldest to newest, ending today (JST)', async () => {
    const body = (await (await call('/api/admin/stats?days=7', adminCookie)).json()) as Body;
    expect(body.generatedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(body.daily.map((d: Day) => d.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(dayAgo));
    for (const d of body.daily) expect(d).toMatchObject({ active: 0, calls: 0, errors: 0 });
    expect(body.tools).toEqual([]);
    expect(body.clients).toEqual([]);
    expect(body.users).toMatchObject({ total: 2, activeToday: 0, activeWeek: 0, activeMonth: 0 });
  });

  it('sums per day, per tool and per client, sorted by calls then name', async () => {
    const [today, yesterday, old] = [dayAgo(0), dayAgo(1), dayAgo(20)];
    count(`d:${today}`, 'calls', 'get_due_items', 5);
    count(`d:${today}`, 'calls', 'list_courses', 2);
    count(`d:${today}`, 'errors', 'list_courses', 1);
    count(`d:${yesterday}`, 'calls', 'get_due_items', 3);
    count(`d:${yesterday}`, 'calls', 'get_grades', 3);
    count(`d:${yesterday}`, 'errors', 'get_due_items', 2);
    count(`d:${old}`, 'calls', 'get_due_items', 100);
    count(`d:${today}`, 'client_calls', 'Claude', 4);
    count(`d:${yesterday}`, 'client_calls', 'Claude', 2);
    count(`d:${yesterday}`, 'client_calls', 'ChatGPT', 3);
    count(`d:${today}`, 'active', '', 4);
    count(`d:${yesterday}`, 'active', '', 6);

    const seven = (await (await call('/api/admin/stats?days=7', adminCookie)).json()) as Body;
    expect(seven.daily.at(-1)).toMatchObject({ day: today, active: 4, calls: 7, errors: 1 });
    expect(seven.daily.at(-2)).toMatchObject({ day: yesterday, active: 6, calls: 6, errors: 2 });
    expect(seven.tools).toEqual([
      { name: 'get_due_items', calls: 8, errors: 2 },
      { name: 'get_grades', calls: 3, errors: 0 },
      { name: 'list_courses', calls: 2, errors: 1 },
    ]);
    expect(seven.clients).toEqual([
      { name: 'Claude', calls: 6, activeMonth: 0 },
      { name: 'ChatGPT', calls: 3, activeMonth: 0 },
    ]);

    // the 30 day range also sees the older day
    const thirty = (await (await call('/api/admin/stats?days=30', adminCookie)).json()) as Body;
    expect(thirty.tools[0]).toEqual({ name: 'get_due_items', calls: 108, errors: 2 });
  });

  it('breaks calls ties by name', async () => {
    const today = dayAgo(0);
    count(`d:${today}`, 'calls', 'zeta', 1);
    count(`d:${today}`, 'calls', 'alpha', 1);
    const body = (await (await call('/api/admin/stats', adminCookie)).json()) as Body;
    expect(body.tools.map((t) => t.name)).toEqual(['alpha', 'zeta']);
  });

  it('reads current day, week and month active users and per-client monthly actives', async () => {
    const now = Date.now();
    const today = jst(now);
    const month = today.slice(0, 7);
    const t = new Date(`${today}T00:00:00Z`);
    const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
    count(`d:${today}`, 'active', '', 3);
    count(`w:${monday}`, 'active', '', 8);
    count(`m:${month}`, 'active', '', 12);
    count(`d:${dayAgo(1)}`, 'active', '', 99); // other days never feed the headline numbers
    count(`w:2020-01-06`, 'active', '', 99);
    count(`m:2020-01`, 'active', '', 99);
    count(`m:${month}`, 'client_active', 'Claude', 7);
    count(`m:${month}`, 'client_active', 'Cursor', 2);
    count(`d:${today}`, 'client_calls', 'Claude', 5);
    count(`d:${today}`, 'client_calls', 'Goose', 1);
    count('m:2020-01', 'client_active', 'Claude', 50);

    const body = (await (await call('/api/admin/stats', adminCookie)).json()) as Body;
    expect(body.users).toMatchObject({ activeToday: 3, activeWeek: 8, activeMonth: 12 });
    // union of both sources, calls desc then name
    expect(body.clients).toEqual([
      { name: 'Claude', calls: 5, activeMonth: 7 },
      { name: 'Goose', calls: 1, activeMonth: 0 },
      { name: 'Cursor', calls: 0, activeMonth: 2 },
    ]);
  });

  it('counts users and buckets new users by JST day', async () => {
    const todayStart = Date.parse(`${dayAgo(0)}T00:00:00+09:00`);
    const yStart = todayStart - DAY_MS;
    addUser(2001, todayStart); // first millisecond of today (JST)
    addUser(2002, todayStart + 1000);
    addUser(2003, yStart); // first millisecond of yesterday
    addUser(2004, todayStart - 1); // last millisecond of yesterday
    addUser(2005, Date.parse(`${dayAgo(20)}T12:00:00+09:00`)); // inside 30 days, outside 7
    addUser(2006, Date.parse(`${dayAgo(200)}T12:00:00+09:00`)); // outside every range

    const seven = (await (await call('/api/admin/stats?days=7', adminCookie)).json()) as Body;
    // the two session users from beforeEach were created today
    expect(seven.daily.at(-1)?.newUsers).toBe(4);
    expect(seven.daily.at(-2)?.newUsers).toBe(2);
    expect(seven.users.total).toBe(8);
    expect(seven.users.newInRange).toBe(6);
    const sumRange = (b: Body) => b.daily.reduce((n, d) => n + d.newUsers, 0);
    expect(seven.users.newInRange).toBe(sumRange(seven));

    const thirty = (await (await call('/api/admin/stats?days=30', adminCookie)).json()) as Body;
    expect(thirty.users.newInRange).toBe(sumRange(thirty));
    expect(thirty.users.newInRange).toBe(seven.users.newInRange + 1);
    const ninety = (await (await call('/api/admin/stats?days=90', adminCookie)).json()) as Body;
    expect(ninety.users.newInRange).toBe(thirty.users.newInRange);
  });
});
