/** GET /api/due: stale-while-revalidate over the stored due-list copies (migration 0015). */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDueItems } from '../../src/core/services/due';
import { isoJst } from '../../src/core/time';
import type { DueList } from '../../src/core/types';
import { createApi } from '../../src/worker/api';
import { SESSION_COOKIE, startSession } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

vi.mock('../../src/core/services/due', () => ({ getDueItems: vi.fn() }));

const ORIGIN = 'https://wasemoodle.example.com';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 11)));
const KEY_14 = 'days=14&overdue_days=&course_id=';

const app = createApi();
let env: Env;
let store: D1Store;
let userId: number;
let cookie: string;
let pending: Promise<unknown>[];
let ipCounter = 0;

function dueList(name: string): DueList {
  return {
    generatedAt: '2026-11-20T09:00:00+09:00',
    windowFrom: '2026-11-06T09:00:00+09:00',
    windowTo: '2026-12-04T09:00:00+09:00',
    items: [
      {
        kind: 'assign',
        source: 'calendar',
        courseId: 99101,
        courseName: '総合日本語３Ｘ',
        cmid: 7001,
        name,
        dueAt: '2026-11-30T23:59:00+09:00',
        url: 'https://wsdmoodle.waseda.jp/mod/assign/view.php?id=7001',
      },
    ],
    scope: { mode: 'mine', courseIds: [99101], otherCount: 0 },
    otherCourses: [],
    sweep: { checked: 1, stale: 0, checkedAt: '2026-11-20T08:17:00+09:00' },
    truncated: false,
  } as unknown as DueList;
}

async function call(path: string): Promise<Response> {
  const headers = new Headers({ 'CF-Connecting-IP': `198.51.100.${++ipCounter}`, Cookie: cookie });
  const execCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, execCtx);
  await Promise.all(pending.splice(0));
  return res;
}

const body = async (res: Response) => (await res.json()) as DueList & { cachedAt: string; stale: boolean };

beforeEach(async () => {
  const { db } = createTestD1();
  env = {
    DB: db,
    OAUTH_KV: new MemoryKV().asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: ORIGIN,
    REGISTRATION: 'allowlist',
    ALLOWED_MOODLE_USERIDS: '1001',
  } as Env;
  store = createD1Store(db);
  const user = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
  userId = user.id;
  const { cookieValue } = await startSession(store, user.id, null);
  cookie = `${SESSION_COOKIE}=${cookieValue}`;
  pending = [];
  vi.mocked(getDueItems).mockReset();
});

describe('GET /api/due', () => {
  it('without a stored copy computes the list with the cached sweep, stores it and answers it fresh', async () => {
    vi.mocked(getDueItems).mockResolvedValue(dueList('レポート１'));
    const res = await call('/api/due?days=14');
    expect(res.status).toBe(200);
    const fresh = await body(res);
    expect(fresh).toMatchObject({ stale: false, items: [{ name: 'レポート１' }] });
    expect(fresh.cachedAt).toMatch(/\+09:00$/);
    expect(vi.mocked(getDueItems).mock.calls[0]?.[1]).toEqual({
      daysAhead: 14,
      overdueDays: undefined,
      courseId: undefined,
      sweep: 'cached',
    });
    expect((await store.getDueCache(userId, KEY_14))?.list.items[0]?.name).toBe('レポート１');
  });

  it('answers a stored copy at once as stale, without computing', async () => {
    const createdAt = Date.UTC(2026, 10, 20, 0, 0, 0);
    await store.putDueCache(userId, KEY_14, { list: dueList('古い課題'), createdAt });
    const res = await call('/api/due');
    const cached = await body(res);
    expect(cached).toMatchObject({ stale: true, cachedAt: isoJst(createdAt), items: [{ name: '古い課題' }] });
    expect(getDueItems).not.toHaveBeenCalled();
  });

  it('refresh=1 always computes, replaces the stored copy and answers fresh', async () => {
    await store.putDueCache(userId, KEY_14, { list: dueList('古い課題'), createdAt: 1 });
    vi.mocked(getDueItems).mockResolvedValue(dueList('新しい課題'));
    const fresh = await body(await call('/api/due?days=14&refresh=1'));
    expect(fresh).toMatchObject({ stale: false, items: [{ name: '新しい課題' }] });
    expect(getDueItems).toHaveBeenCalledTimes(1);
    const stored = await store.getDueCache(userId, KEY_14);
    expect(stored?.list.items[0]?.name).toBe('新しい課題');
    expect(stored?.createdAt).toBeGreaterThan(1);
    // the next plain request answers the refreshed copy
    expect(await body(await call('/api/due'))).toMatchObject({ stale: true, items: [{ name: '新しい課題' }] });
  });

  it('keeps one copy per query', async () => {
    await store.putDueCache(userId, KEY_14, { list: dueList('14日'), createdAt: 1 });
    vi.mocked(getDueItems).mockResolvedValue(dueList('講義別'));
    const other = await body(await call('/api/due?days=7&overdue_days=3&course_id=99101'));
    expect(other).toMatchObject({ stale: false, items: [{ name: '講義別' }] });
    expect(vi.mocked(getDueItems).mock.calls[0]?.[1]).toMatchObject({ daysAhead: 7, overdueDays: 3, courseId: 99101 });
    expect((await store.getDueCache(userId, 'days=7&overdue_days=3&course_id=99101'))?.list.items[0]?.name).toBe(
      '講義別',
    );
    expect((await store.getDueCache(userId, KEY_14))?.list.items[0]?.name).toBe('14日');
  });

  it('stores nothing when the computation fails', async () => {
    vi.mocked(getDueItems).mockRejectedValue(new Error('boom'));
    expect((await call('/api/due')).status).toBe(500);
    expect(await store.getDueCache(userId, KEY_14)).toBeNull();
  });

  it('validates the options before reading the copy', async () => {
    expect((await call('/api/due?days=0')).status).toBe(400);
    expect((await call('/api/due?course_id=x&refresh=1')).status).toBe(400);
  });
});
