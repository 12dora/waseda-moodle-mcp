import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import { resolveScope, setMyCourses } from '../../src/core/services/scope';
import { getCourseUpdates } from '../../src/core/services/sweep';
import { createApi } from '../../src/worker/api';
import { SESSION_COOKIE, startSession } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';
import { createD1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

vi.mock('../../src/core/services/scope', () => ({ resolveScope: vi.fn(), setMyCourses: vi.fn() }));
vi.mock('../../src/core/services/sweep', () => ({ getCourseUpdates: vi.fn() }));

const ORIGIN = 'https://wasemoodle.example.com';
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 9)));
const DEFAULTS = { writeMode: 'chat', myCourseIds: null, uiLang: 'auto' };

interface Body {
  settings: Record<string, unknown>;
  user: { settings: Record<string, unknown> };
  mode: string;
  courses: unknown[];
  updates: unknown[];
}

const app = createApi();
let env: Env;
let cookie: string;
let ipCounter = 0;

async function call(path: string, init: { method?: string; body?: unknown; signed?: boolean } = {}): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers = new Headers({ 'CF-Connecting-IP': `198.51.100.${++ipCounter}` });
  if (init.signed !== false) headers.set('Cookie', cookie);
  if (method !== 'GET') {
    headers.set('X-WMM', '1');
    headers.set('Origin', ORIGIN);
    headers.set('Content-Type', 'application/json');
  }
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const execCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, execCtx);
}

const patch = (body: unknown) => call('/api/settings', { method: 'PATCH', body });
const json = async (res: Response) => (await res.json()) as Body;
const myCourseIdsOf = async () => (await json(await call('/api/me'))).user.settings.myCourseIds;

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

  vi.mocked(resolveScope).mockReset();
  vi.mocked(getCourseUpdates).mockReset();
  // stands in for the real service: persists the confirmed scope the way setMyCourses does
  vi.mocked(setMyCourses)
    .mockReset()
    .mockImplementation(async (ctx, ids) => {
      const settings = { ...ctx.user.settings, myCourseIds: ids };
      await ctx.store.updateSettings(ctx.user.id, settings);
      return settings;
    });
});

describe('PATCH /api/settings', () => {
  it('validates and persists writeMode / uiLang without touching the course scope', async () => {
    const ok = await patch({ writeMode: 'console', uiLang: 'ja' });
    expect(ok.status).toBe(200);
    expect((await json(ok)).settings).toEqual({ ...DEFAULTS, writeMode: 'console', uiLang: 'ja' });
    expect(setMyCourses).not.toHaveBeenCalled();

    expect((await json(await patch({ uiLang: 'en' }))).settings).toEqual({
      ...DEFAULTS,
      writeMode: 'console',
      uiLang: 'en',
    });
    for (const bad of [{ writeMode: 'always' }, { uiLang: 'fr' }]) {
      expect((await patch(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await json(await call('/api/me'))).user.settings).toEqual({
      ...DEFAULTS,
      writeMode: 'console',
      uiLang: 'en',
    });
    expect((await call('/api/settings', { method: 'PATCH', body: {}, signed: false })).status).toBe(401);
  });

  it('sets and clears myCourseIds through setMyCourses with a console context', async () => {
    const set = await patch({ myCourseIds: [5, 6, 5], writeMode: 'off' });
    expect(set.status).toBe(200);
    expect((await json(set)).settings).toEqual({ ...DEFAULTS, writeMode: 'off', myCourseIds: [5, 6] });
    const [ctx, ids] = vi.mocked(setMyCourses).mock.calls[0] ?? [];
    expect(ids).toEqual([5, 6]);
    expect(ctx).toMatchObject({ source: 'Console', user: { moodleUserId: 1001 } });
    expect(await myCourseIdsOf()).toEqual([5, 6]);

    expect((await json(await patch({ myCourseIds: null }))).settings).toMatchObject({ myCourseIds: null });
    expect(await myCourseIdsOf()).toBeNull();
  });

  it('rejects malformed ids, more than 60 ids and the retired hiddenCourseIds', async () => {
    const tooMany = Array.from({ length: 61 }, (_, i) => i + 1);
    for (const bad of [
      { myCourseIds: ['x'] },
      { myCourseIds: 'all' },
      { myCourseIds: [1.5] },
      { myCourseIds: [0] },
      { myCourseIds: [-3] },
      { myCourseIds: tooMany },
      { myCourseIds: [] }, // would hide every calendar item: select something or reset to null
      { hiddenCourseIds: [1] },
      { hiddenCourseIds: null },
    ]) {
      expect((await patch(bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect(setMyCourses).not.toHaveBeenCalled();
    expect((await patch({ myCourseIds: tooMany.slice(0, 60) })).status).toBe(200);
  });

  it('applies nothing when setMyCourses rejects (not enrolled)', async () => {
    vi.mocked(setMyCourses).mockRejectedValueOnce(new InvalidInput('You are not enrolled in course 9.'));
    expect((await patch({ myCourseIds: [9], writeMode: 'off' })).status).toBe(400);
    expect((await json(await call('/api/me'))).user.settings).toEqual(DEFAULTS);
  });
});

describe('GET /api/courses and /api/updates', () => {
  it('returns the resolved scope: mode plus every enrolled course', async () => {
    const courses = [{ id: 1, kind: 'class', mine: true, suggested: true }];
    vi.mocked(resolveScope).mockResolvedValue({ mode: 'auto', mine: new Set([1]), courses } as never);
    const res = await call('/api/courses?classification=all');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: 'auto', courses });
    expect(vi.mocked(resolveScope).mock.calls[0]?.[0]).toMatchObject({
      source: 'Console',
      user: { moodleUserId: 1001 },
    });
    expect((await call('/api/courses', { signed: false })).status).toBe(401);
  });

  it('passes sinceDays (default 7) to getCourseUpdates and validates it', async () => {
    const payload = { updates: [], stats: { checked: 2, stale: 0, checkedAt: null } };
    vi.mocked(getCourseUpdates).mockResolvedValue(payload);
    expect(await (await call('/api/updates')).json()).toEqual(payload);
    expect(vi.mocked(getCourseUpdates).mock.calls[0]?.[1]).toEqual({ sinceDays: 7 });
    expect((await call('/api/updates?days=3')).status).toBe(200);
    expect(vi.mocked(getCourseUpdates).mock.calls[1]?.[1]).toEqual({ sinceDays: 3 });
    for (const days of ['0', '31', 'abc']) {
      expect((await call(`/api/updates?days=${days}`)).status, days).toBe(400);
    }
    expect((await call('/api/updates', { signed: false })).status).toBe(401);
  });
});
