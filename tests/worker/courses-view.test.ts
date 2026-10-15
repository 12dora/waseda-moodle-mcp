import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, NotFound } from '../../src/core/errors';
import { getCourseOverview, getSyllabusSummary } from '../../src/core/services/course-overview';
import { getCourseUpdates } from '../../src/core/services/sweep';
import { createApi } from '../../src/worker/api';
import { SESSION_COOKIE, startSession } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { createD1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

vi.mock('../../src/core/services/course-overview', () => ({
  getCourseOverview: vi.fn(),
  getSyllabusSummary: vi.fn(),
}));
vi.mock('../../src/core/services/sweep', () => ({ getCourseUpdates: vi.fn() }));

const ORIGIN = 'https://wasemoodle.example.com';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 11)));

const app = createApi();
let env: Env;
let cookie: string;
let ipCounter = 0;

async function call(path: string, init: { signed?: boolean } = {}): Promise<Response> {
  const headers = new Headers({ 'CF-Connecting-IP': `198.51.100.${++ipCounter}` });
  if (init.signed !== false) headers.set('Cookie', cookie);
  const execCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, execCtx);
}

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
  const store = createD1Store(db);
  const user = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
  const { cookieValue } = await startSession(store, user.id, null);
  cookie = `${SESSION_COOKIE}=${cookieValue}`;
  vi.mocked(getCourseOverview).mockReset();
  vi.mocked(getSyllabusSummary).mockReset();
  vi.mocked(getCourseUpdates).mockReset();
});

describe('GET /api/courses/overview', () => {
  it('returns the service payload with a console context', async () => {
    const payload = { generatedAt: '2026-10-14T12:00:00+09:00', scopeMode: 'mine', dueError: false, courses: [] };
    vi.mocked(getCourseOverview).mockResolvedValue(payload as never);
    const res = await call('/api/courses/overview');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(vi.mocked(getCourseOverview).mock.calls[0]?.[0]).toMatchObject({
      source: 'Console',
      user: { moodleUserId: 1001 },
    });
    expect((await call('/api/courses/overview', { signed: false })).status).toBe(401);
  });
});

describe('GET /api/syllabus', () => {
  it('requires and validates course_id, then returns the summary', async () => {
    const payload = {
      courseId: 7,
      url: 'https://www.wsl.waseda.jp/syllabus/JAA104.php?pKey=x&pLng=jp',
      grading: [{ method: '試験', weight: 60, criteria: '期末' }],
      gradingText: null,
      status: 'found',
    };
    vi.mocked(getSyllabusSummary).mockResolvedValue(payload as never);
    const res = await call('/api/syllabus?course_id=7');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(vi.mocked(getSyllabusSummary).mock.calls[0]?.[1]).toBe(7);

    expect((await call('/api/syllabus')).status).toBe(400);
    expect((await call('/api/syllabus?course_id=abc')).status).toBe(400);
    expect((await call('/api/syllabus?course_id=0')).status).toBe(400);
    expect((await call('/api/syllabus?course_id=7', { signed: false })).status).toBe(401);
  });

  it('maps a foreign course to 404', async () => {
    vi.mocked(getSyllabusSummary).mockRejectedValue(new NotFound('That course is not among your enrolled courses.'));
    const res = await call('/api/syllabus?course_id=99');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('GET /api/updates course_id', () => {
  it('passes a validated course_id through to getCourseUpdates', async () => {
    const payload = { updates: [], stats: { checked: 0, stale: 0, checkedAt: null } };
    vi.mocked(getCourseUpdates).mockResolvedValue(payload);
    expect((await call('/api/updates?days=3&course_id=42')).status).toBe(200);
    expect(vi.mocked(getCourseUpdates).mock.calls[0]?.[1]).toEqual({ sinceDays: 3, courseId: 42 });
    expect((await call('/api/updates?course_id=abc')).status).toBe(400);
    expect((await call('/api/updates?course_id=0')).status).toBe(400);
  });

  it('maps a foreign course to 404', async () => {
    vi.mocked(getCourseUpdates).mockRejectedValue(new NotFound('That course is not among your enrolled courses.'));
    const res = await call('/api/updates?course_id=99');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('maps invalid_input from the service', async () => {
    vi.mocked(getCourseUpdates).mockRejectedValue(new InvalidInput('days'));
    expect((await call('/api/updates?days=7')).status).toBe(400);
  });
});
