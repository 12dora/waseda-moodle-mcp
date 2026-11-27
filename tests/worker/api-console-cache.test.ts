/**
 * Stale-while-revalidate over the console's stored answer copies (console-cache.ts, migration 0016): every cached
 * route, its keys and options, the degraded answers it does not store, and the console writes that clear the copies.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { InvalidInput, MoodleBusy } from '../../src/core/errors';
import { connectAccount } from '../../src/core/services/account';
import { confirmAction } from '../../src/core/services/actions';
import { getCourseOverview, getSyllabusSummary } from '../../src/core/services/course-overview';
import { getDueItems } from '../../src/core/services/due';
import { resolveScope, setMyCourses } from '../../src/core/services/scope';
import { getCourseUpdates } from '../../src/core/services/sweep';
import { getTimetable } from '../../src/core/services/timetable';
import { isoJst } from '../../src/core/time';
import { createApi } from '../../src/worker/api';
import { resetRateLimitMemory, SESSION_COOKIE, startSession } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

vi.mock('../../src/core/services/due', () => ({ getDueItems: vi.fn() }));
vi.mock('../../src/core/services/scope', () => ({ resolveScope: vi.fn(), setMyCourses: vi.fn() }));
vi.mock('../../src/core/services/sweep', () => ({ getCourseUpdates: vi.fn() }));
vi.mock('../../src/core/services/timetable', () => ({ getTimetable: vi.fn() }));
vi.mock('../../src/core/services/course-overview', () => ({
  getCourseOverview: vi.fn(),
  getSyllabusSummary: vi.fn(),
}));
vi.mock('../../src/core/services/actions', () => ({
  confirmAction: vi.fn(),
  cancelAction: vi.fn(),
  listActionRecords: vi.fn(),
}));
vi.mock('../../src/core/services/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/services/account')>()),
  connectAccount: vi.fn(),
}));

const ORIGIN = 'https://wasemoodle.example.com';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 11)));
const DUE_14 = '/api/due?days=14&overdue_days=&course_id=';
const COURSES = '/api/courses?';
const UPDATES_7 = '/api/updates?days=7&course_id=';

const app = createApi();
let env: Env;
let store: D1Store;
let userId: number;
let cookie: string;
let pending: Promise<unknown>[];
let ipCounter = 0;

async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers = new Headers({ 'CF-Connecting-IP': `198.51.100.${++ipCounter}`, Cookie: cookie });
  if (method !== 'GET') {
    headers.set('X-WMM', '1');
    headers.set('Origin', ORIGIN);
    headers.set('Content-Type', 'application/json');
  }
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const execCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, execCtx);
  await Promise.all(pending.splice(0));
  return res;
}

type Answer = Record<string, unknown> & { cachedAt: string; stale: boolean };
const answer = async (res: Response) => (await res.json()) as Answer;
const stored = async (key: string) => (await store.getConsoleCache<Record<string, unknown>>(userId, key))?.body;
const put = (key: string, body: object, createdAt = 1) => store.putConsoleCache(userId, key, { body, createdAt });

/** One cached route: the request, its cache key, the service it computes with and the answer it makes of `name`. */
interface RouteCase {
  route: string;
  path: string;
  key: string;
  service: Mock;
  /** What the service resolves to for `name`. */
  value: (name: string) => unknown;
  /** The answer body for that value (without cachedAt / stale). */
  body: (name: string) => Record<string, unknown>;
}

const mockOf = (fn: unknown) => fn as Mock;
const same = (make: (name: string) => Record<string, unknown>) => ({ value: make, body: make });

const ROUTES: RouteCase[] = [
  {
    route: '/api/due',
    path: '/api/due?days=14',
    key: DUE_14,
    service: mockOf(getDueItems),
    ...same((name) => ({ items: [{ name, courseId: 99101 }], truncated: false })),
  },
  {
    route: '/api/courses',
    path: '/api/courses',
    key: COURSES,
    service: mockOf(resolveScope),
    value: (name) => ({ mode: 'auto', mine: new Set([99101]), courses: [{ id: 99101, fullname: name }] }),
    body: (name) => ({ mode: 'auto', courses: [{ id: 99101, fullname: name }] }),
  },
  {
    route: '/api/courses/overview',
    path: '/api/courses/overview',
    key: '/api/courses/overview?',
    service: mockOf(getCourseOverview),
    ...same((name) => ({ scopeMode: 'mine', dueError: false, courses: [{ id: 99101, fullname: name }] })),
  },
  {
    route: '/api/timetable',
    path: '/api/timetable?date=2026-11-30&days=7',
    key: '/api/timetable?date=2026-11-30&days=7',
    service: mockOf(getTimetable),
    ...same((name) => ({ from: '2026-11-30', to: '2026-12-06', days: [], unknown: [{ name }] })),
  },
  {
    route: '/api/updates',
    path: '/api/updates',
    key: UPDATES_7,
    service: mockOf(getCourseUpdates),
    ...same((name) => ({ updates: [{ name, cmid: 7001 }], stats: { checked: 1, stale: 0, checkedAt: null } })),
  },
  {
    route: '/api/syllabus',
    path: '/api/syllabus?course_id=99101',
    key: '/api/syllabus?course_id=99101',
    service: mockOf(getSyllabusSummary),
    ...same((name) => ({ courseId: 99101, url: null, grading: null, gradingText: name, status: 'found' })),
  },
];

beforeEach(async () => {
  resetRateLimitMemory();
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
  for (const r of ROUTES) r.service.mockReset();
  vi.mocked(confirmAction).mockReset();
  vi.mocked(connectAccount).mockReset();
  vi.mocked(setMyCourses)
    .mockReset()
    .mockImplementation(async (ctx, ids) => ({ ...ctx.user.settings, myCourseIds: ids }));
});

describe.each(ROUTES)('GET $route', (r) => {
  it('without a stored copy computes, stores the answer and answers it fresh', async () => {
    r.service.mockResolvedValue(r.value('一回目'));
    const res = await call(r.path);
    expect(res.status).toBe(200);
    const fresh = await answer(res);
    expect(fresh).toEqual({ ...r.body('一回目'), cachedAt: expect.stringMatching(/\+09:00$/), stale: false });
    expect(r.service).toHaveBeenCalledTimes(1);
    expect(r.service.mock.calls[0]?.[0]).toMatchObject({ source: 'Console', user: { moodleUserId: 1001 } });
    expect(await stored(r.key)).toEqual(r.body('一回目'));
  });

  it('answers a stored copy at once as stale, without computing', async () => {
    const createdAt = Date.UTC(2026, 10, 20, 0, 0, 0);
    await put(r.key, r.body('古い'), createdAt);
    const cached = await answer(await call(r.path));
    expect(cached).toEqual({ ...r.body('古い'), cachedAt: isoJst(createdAt), stale: true });
    expect(r.service).not.toHaveBeenCalled();
  });

  it('refresh=1 computes, replaces the copy and answers fresh; the next plain read answers the new copy', async () => {
    await put(r.key, r.body('古い'));
    r.service.mockResolvedValue(r.value('新しい'));
    const sep = r.path.includes('?') ? '&' : '?';
    expect(await answer(await call(`${r.path}${sep}refresh=1`))).toMatchObject({ ...r.body('新しい'), stale: false });
    expect(r.service).toHaveBeenCalledTimes(1);
    expect(await stored(r.key)).toEqual(r.body('新しい'));
    expect(await answer(await call(r.path))).toMatchObject({ ...r.body('新しい'), stale: true });
    expect(r.service).toHaveBeenCalledTimes(1);
  });

  it('a failed compute stores nothing and keeps the previous copy', async () => {
    r.service.mockRejectedValue(new Error('boom'));
    expect((await call(r.path)).status).toBe(500);
    expect(await stored(r.key)).toBeUndefined();
    await put(r.key, r.body('前回'));
    const sep = r.path.includes('?') ? '&' : '?';
    expect((await call(`${r.path}${sep}refresh=1`)).status).toBe(500);
    expect(await stored(r.key)).toEqual(r.body('前回'));
  });

  it('needs a session', async () => {
    cookie = '';
    expect((await call(r.path)).status).toBe(401);
  });
});

describe('while the Moodle web session is busy (a request ran out of time)', () => {
  const OVERVIEW = '/api/courses/overview?';
  const busyFor = async (ms: number) => {
    await store.putCredential({
      userId,
      tokenEnc: null,
      privateTokenEnc: null,
      tokenHash: null,
      tokenHint: null,
      status: 'active',
      connectedVia: 'extension',
      connectedAt: 1,
      lastOkAt: 1,
      lastError: null,
    });
    await store.updateCredentialStatus(userId, { sessionEnc: 'enc-cookie', busyUntil: Date.now() + ms });
  };

  it.each(ROUTES)('$route: refresh=1 answers the stored copy as stale and busy, without computing', async (r) => {
    await busyFor(60_000);
    await put(r.key, r.body('古い'), 5);
    const sep = r.path.includes('?') ? '&' : '?';
    const res = await call(`${r.path}${sep}refresh=1`);
    expect(res.status).toBe(200);
    expect(await answer(res)).toEqual({ ...r.body('古い'), cachedAt: isoJst(5), stale: true, busy: true });
    expect(r.service).not.toHaveBeenCalled();
    expect(await stored(r.key)).toEqual(r.body('古い'));
  });

  it('without a copy answers moodle_busy (503, Retry-After) instead of calling Moodle', async () => {
    await busyFor(60_000);
    for (const path of ['/api/courses/overview', '/api/courses/overview?refresh=1']) {
      const res = await call(path);
      expect(res.status, path).toBe(503);
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(55);
      const body = (await res.json()) as { error: { code: string; retryAfter: number } };
      expect(body.error).toMatchObject({ code: 'moodle_busy', retryAfter: expect.any(Number) });
    }
    expect(getCourseOverview).not.toHaveBeenCalled();
  });

  it('a plain read still answers its copy as usual; an expired mark computes again', async () => {
    await busyFor(60_000);
    await put(OVERVIEW, { dueError: false, courses: [] }, 5);
    expect(await answer(await call('/api/courses/overview'))).toEqual({
      dueError: false,
      courses: [],
      cachedAt: isoJst(5),
      stale: true,
    });
    await busyFor(-1);
    vi.mocked(getCourseOverview).mockResolvedValue({ dueError: false, courses: [{ id: 2 }] } as never);
    expect(await answer(await call('/api/courses/overview?refresh=1'))).toMatchObject({ stale: false });
    expect(getCourseOverview).toHaveBeenCalledTimes(1);
  });

  it('a compute that finds the session busy answers the copy (or moodle_busy) and stores nothing', async () => {
    vi.mocked(getCourseOverview).mockRejectedValue(new MoodleBusy(Date.now() + 120_000));
    expect((await call('/api/courses/overview')).status).toBe(503);
    await put(OVERVIEW, { dueError: false, courses: [{ id: 1 }] }, 5);
    const res = await answer(await call('/api/courses/overview?refresh=1'));
    expect(res).toMatchObject({ courses: [{ id: 1 }], stale: true, busy: true });
    expect(await stored(OVERVIEW)).toEqual({ dueError: false, courses: [{ id: 1 }] });
  });
});

describe('cache keys and options', () => {
  it('keeps one due copy per normalised query', async () => {
    await put(DUE_14, { items: [{ name: '14日' }] });
    vi.mocked(getDueItems).mockResolvedValue({ items: [{ name: '講義別' }] } as never);
    const other = await answer(await call('/api/due?course_id=99101&overdue_days=3&days=7'));
    expect(other).toMatchObject({ stale: false, items: [{ name: '講義別' }] });
    expect(vi.mocked(getDueItems).mock.calls[0]?.[1]).toEqual({
      daysAhead: 7,
      overdueDays: 3,
      courseId: 99101,
      sweep: 'cached',
    });
    expect(await stored('/api/due?days=7&overdue_days=3&course_id=99101')).toEqual({ items: [{ name: '講義別' }] });
    expect(await answer(await call('/api/due'))).toMatchObject({ stale: true, items: [{ name: '14日' }] });
  });

  it('keys the timetable by the resolved JST date, so "today" is never yesterday\'s copy', async () => {
    const today = isoJst(Date.now()).slice(0, 10);
    vi.mocked(getTimetable).mockResolvedValue({ from: today } as never);
    await call('/api/timetable');
    expect(vi.mocked(getTimetable).mock.calls[0]?.[1]).toEqual({ date: today, days: 1 });
    expect(await stored(`/api/timetable?date=${today}&days=1`)).toEqual({ from: today });
    expect(await answer(await call('/api/timetable?date=today&days=1'))).toMatchObject({ stale: true });
    expect(getTimetable).toHaveBeenCalledTimes(1);
  });

  it('passes updates options through and keys them', async () => {
    vi.mocked(getCourseUpdates).mockResolvedValue({ updates: [], stats: { checked: 0, stale: 0, checkedAt: null } });
    await call('/api/updates?days=3&course_id=42');
    expect(vi.mocked(getCourseUpdates).mock.calls[0]?.[1]).toEqual({ sinceDays: 3, courseId: 42 });
    expect(await stored('/api/updates?days=3&course_id=42')).toBeDefined();
  });

  it('validates the options before reading a copy', async () => {
    await put(DUE_14, { items: [] });
    for (const path of [
      '/api/due?days=0',
      '/api/due?course_id=x&refresh=1',
      '/api/updates?days=31',
      '/api/timetable?days=15',
      '/api/timetable?date=nope',
      '/api/syllabus',
      '/api/syllabus?course_id=0',
    ]) {
      expect((await call(path)).status, path).toBe(400);
    }
    for (const r of ROUTES) expect(r.service).not.toHaveBeenCalled();
  });

  it('maps a bad date the service rejects to 400 and stores nothing', async () => {
    vi.mocked(getTimetable).mockRejectedValue(new InvalidInput('date must be YYYY-MM-DD (years 2000-2100).'));
    expect((await call('/api/timetable?date=1900-01-01')).status).toBe(400);
    expect(await stored('/api/timetable?date=1900-01-01&days=1')).toBeUndefined();
  });

  it('answers but does not store a degraded overview or a failed syllabus lookup', async () => {
    await put('/api/courses/overview?', { dueError: false, courses: [{ id: 1 }] });
    vi.mocked(getCourseOverview).mockResolvedValue({ dueError: true, courses: [] } as never);
    expect(await answer(await call('/api/courses/overview?refresh=1'))).toMatchObject({ dueError: true, stale: false });
    expect(await stored('/api/courses/overview?')).toEqual({ dueError: false, courses: [{ id: 1 }] });

    vi.mocked(getSyllabusSummary).mockResolvedValue({ courseId: 7, status: 'error' } as never);
    expect(await answer(await call('/api/syllabus?course_id=7'))).toMatchObject({ status: 'error', stale: false });
    expect(await stored('/api/syllabus?course_id=7')).toBeUndefined();
  });
});

describe('invalidation', () => {
  const seed = async () => {
    await put(DUE_14, { items: [] });
    await put(COURSES, { mode: 'auto', courses: [] });
  };

  it("a course selection or schedule change clears the user's copies; writeMode / uiLang alone does not", async () => {
    await seed();
    expect((await call('/api/settings', { method: 'PATCH', body: { uiLang: 'ja' } })).status).toBe(200);
    expect(await stored(DUE_14)).toBeDefined();

    expect((await call('/api/settings', { method: 'PATCH', body: { myCourseIds: [99101] } })).status).toBe(200);
    expect(await stored(DUE_14)).toBeUndefined();
    expect(await stored(COURSES)).toBeUndefined();
  });

  it('a rejected settings patch keeps the copies', async () => {
    await seed();
    vi.mocked(setMyCourses).mockRejectedValueOnce(new InvalidInput('You are not enrolled in course 9.'));
    expect((await call('/api/settings', { method: 'PATCH', body: { myCourseIds: [9] } })).status).toBe(400);
    expect(await stored(DUE_14)).toBeDefined();
  });

  it('an executed approval clears the copies; a failed one keeps them', async () => {
    await seed();
    const result = (status: string) => ({ actionId: 'act_1', status, message: 'x', url: null });
    vi.mocked(confirmAction).mockResolvedValueOnce(result('failed') as never);
    await call('/api/actions/act_1/approve', { method: 'POST' });
    expect(await stored(DUE_14)).toBeDefined();
    vi.mocked(confirmAction).mockResolvedValueOnce(result('executed') as never);
    expect((await call('/api/actions/act_1/approve', { method: 'POST' })).status).toBe(200);
    expect(await stored(DUE_14)).toBeUndefined();
  });

  it('a reconnect clears the copies of the account signed in', async () => {
    await seed();
    const user = await store.getUser(userId);
    vi.mocked(connectAccount).mockResolvedValue({ user, created: false, changed: true } as never);
    const res = await call('/api/connect', { method: 'POST', body: { session: 'MoodleSession=abc', via: 'paste' } });
    expect(res.status).toBe(200);
    expect(await stored(DUE_14)).toBeUndefined();
    expect(await stored(COURSES)).toBeUndefined();
  });
});
