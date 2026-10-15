import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionRow, ApiKeyRow, CourseSnapshotRow, CredentialRow, UserRow } from '../../src/core/context';
import type { InferredSchedule } from '../../src/core/types';
import { AUDIT_RETENTION_MS } from '../../src/worker/store/logs';
import { normalizeSettings } from '../../src/worker/store/rows';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';

let t: TestD1;
let store: D1Store;
let user: UserRow;

const credential = (userId: number, over: Partial<CredentialRow> = {}): CredentialRow => ({
  userId,
  tokenEnc: 'enc-token',
  privateTokenEnc: null,
  tokenHash: 'hash-1',
  tokenHint: 'abcd',
  status: 'active',
  connectedVia: 'paste',
  connectedAt: 1000,
  lastOkAt: null,
  lastError: null,
  ...over,
});

const apiKey = (userId: number, id: string, hash: string, over: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id,
  userId,
  name: 'laptop',
  prefix: 'wmm_ab12',
  keyHash: hash,
  scopes: ['moodle:read'],
  createdAt: 1000,
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

const action = (userId: number, id: string, over: Partial<ActionRow> = {}): ActionRow => ({
  id,
  userId,
  kind: 'message',
  status: 'pending',
  approval: 'chat',
  title: 'Send message',
  details: ['To: Teacher'],
  warnings: [],
  payload: { conversationId: 5 },
  source: 'Claude',
  createdAt: 1000,
  expiresAt: 5000,
  executedAt: null,
  result: null,
  error: null,
  ...over,
});

const count = (table: string, userId: number): number =>
  (t.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number }).n;

beforeEach(async () => {
  t = createTestD1();
  store = createD1Store(t.db);
  user = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
});

describe('users', () => {
  it('creates a user with default settings and updates profile fields on conflict', async () => {
    expect(user).toMatchObject({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
    expect(user.settings).toEqual({ writeMode: 'chat', myCourseIds: null, uiLang: 'auto', scheduleOverrides: {} });

    await store.updateSettings(user.id, {
      writeMode: 'console',
      myCourseIds: [7, 9],
      uiLang: 'zh-CN',
      scheduleOverrides: {},
    });
    const again = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Y.', lang: 'en' });
    expect(again.id).toBe(user.id);
    expect(again.fullname).toBe('Taro Y.');
    expect(again.lang).toBe('en');
    // settings survive a profile refresh
    expect(again.settings).toEqual({
      writeMode: 'console',
      myCourseIds: [7, 9],
      uiLang: 'zh-CN',
      scheduleOverrides: {},
    });
    expect((await store.getUserByMoodleId(1001))?.id).toBe(user.id);
    expect(await store.getUser(9999)).toBeNull();
  });

  it('touchUser records last seen', async () => {
    await store.touchUser(user.id, 123456);
    expect((await store.getUser(user.id))?.lastSeenAt).toBe(123456);
  });

  it('normalizeSettings repairs invalid input', () => {
    expect(normalizeSettings({ writeMode: 'bogus', myCourseIds: [1, 1, -2, 'x', 3.5, 4], uiLang: 'fr' })).toEqual({
      writeMode: 'chat',
      myCourseIds: [1, 4],
      uiLang: 'auto',
      scheduleOverrides: {},
    });
    expect(normalizeSettings(null).myCourseIds).toBeNull();
    expect(normalizeSettings({ myCourseIds: [] }).myCourseIds).toEqual([]); // confirmed "no courses" stays distinct
    // the retired field is ignored, not migrated
    expect(normalizeSettings({ hiddenCourseIds: [3] })).toEqual({
      writeMode: 'chat',
      myCourseIds: null,
      uiLang: 'auto',
      scheduleOverrides: {},
    });
  });

  it('keeps schedule overrides, drops invalid entries and reads a row saved without them as {}', async () => {
    const slots = [{ weekday: 5, periodFrom: 1, periodTo: 2, classroom: '22-909' }];
    const good = { mode: 'slots' as const, slots };
    const mixed = { '300907': good, '5': { mode: 'slots', slots: [] }, '0': good, abc: good, '6': { mode: 'x' } };
    expect(normalizeSettings({ scheduleOverrides: mixed }).scheduleOverrides).toEqual({ '300907': good });
    expect(normalizeSettings({ scheduleOverrides: [good] }).scheduleOverrides).toEqual({});

    await store.updateSettings(user.id, { ...user.settings, scheduleOverrides: { '300907': good } });
    expect((await store.getUser(user.id))?.settings.scheduleOverrides).toEqual({ '300907': good });
    // a settings row written before scheduleOverrides existed
    await t.db
      .prepare('UPDATE users SET settings = ? WHERE id = ?')
      .bind('{"writeMode":"off","myCourseIds":[3],"uiLang":"ja"}', user.id)
      .run();
    expect((await store.getUser(user.id))?.settings).toEqual({
      writeMode: 'off',
      myCourseIds: [3],
      uiLang: 'ja',
      scheduleOverrides: {},
    });
  });
});

describe('credentials', () => {
  it('stores, replaces and patches a credential', async () => {
    await store.putCredential(credential(user.id, { privateTokenEnc: 'enc-private' }));
    expect(await store.getCredential(user.id)).toMatchObject({ tokenEnc: 'enc-token', privateTokenEnc: 'enc-private' });

    await store.putCredential(
      credential(user.id, { tokenEnc: 'enc-2', tokenHash: 'hash-2', connectedVia: 'extension' }),
    );
    expect(await store.getCredential(user.id)).toMatchObject({
      tokenEnc: 'enc-2',
      tokenHash: 'hash-2',
      connectedVia: 'extension',
      privateTokenEnc: null,
    });

    await store.updateCredentialStatus(user.id, { status: 'invalid', lastError: 'expired' });
    expect(await store.getCredential(user.id)).toMatchObject({
      status: 'invalid',
      lastError: 'expired',
      lastOkAt: null,
    });

    await store.updateCredentialStatus(user.id, { status: 'active', lastOkAt: 777, lastError: null });
    expect(await store.getCredential(user.id)).toMatchObject({ status: 'active', lastOkAt: 777, lastError: null });

    await store.updateCredentialStatus(user.id, {}); // no-op
    expect(await store.getCredential(9999)).toBeNull();
  });
});

describe('sessions', () => {
  it('joins session and user in one lookup and slides the expiry', async () => {
    await store.createSession({
      idHash: 'h1',
      userId: user.id,
      createdAt: 1000,
      expiresAt: 9000,
      lastSeenAt: 1000,
      userAgent: 'UA',
    });
    const found = await store.getSessionWithUser('h1');
    expect(found?.user.id).toBe(user.id);
    expect(found?.session).toMatchObject({ idHash: 'h1', expiresAt: 9000, userAgent: 'UA' });
    expect(await store.getSessionWithUser('nope')).toBeNull();

    await store.touchSession('h1', 2000, 12000);
    expect(await store.getSession('h1')).toMatchObject({ lastSeenAt: 2000, expiresAt: 12000 });

    await store.deleteSession('h1');
    expect(await store.getSession('h1')).toBeNull();
  });

  it('deleteUserSessions removes every session of the user', async () => {
    for (const id of ['a', 'b']) {
      await store.createSession({
        idHash: id,
        userId: user.id,
        createdAt: 1,
        expiresAt: 2,
        lastSeenAt: 1,
        userAgent: null,
      });
    }
    await store.deleteUserSessions(user.id);
    expect(count('sessions', user.id)).toBe(0);
  });
});

describe('api keys', () => {
  it('looks up by hash, lists newest first, revokes once and touches', async () => {
    await store.createApiKey(apiKey(user.id, 'key_a', 'h-a', { createdAt: 1000 }));
    await store.createApiKey(
      apiKey(user.id, 'key_b', 'h-b', { createdAt: 2000, scopes: ['moodle:read', 'moodle:write'] }),
    );
    expect((await store.listApiKeys(user.id)).map((k) => k.id)).toEqual(['key_b', 'key_a']);
    expect((await store.getApiKeyByHash('h-b'))?.scopes).toEqual(['moodle:read', 'moodle:write']);
    expect(await store.getApiKeyByHash('missing')).toBeNull();

    expect(await store.revokeApiKey(user.id, 'key_a', 5000)).toBe(true);
    expect(await store.revokeApiKey(user.id, 'key_a', 6000)).toBe(false); // already revoked
    expect(await store.revokeApiKey(user.id + 1, 'key_b', 6000)).toBe(false); // someone else's
    expect((await store.getApiKeyByHash('h-a'))?.revokedAt).toBe(5000);

    await store.touchApiKey('key_b', 4242);
    expect((await store.getApiKeyByHash('h-b'))?.lastUsedAt).toBe(4242);
  });
});

describe('actions', () => {
  it('round-trips JSON columns, patches and filters', async () => {
    await store.createAction(action(user.id, 'act_1', { createdAt: 1000 }));
    await store.createAction(action(user.id, 'act_2', { createdAt: 2000, status: 'executed', kind: 'completion' }));
    await store.createAction(action(user.id, 'act_3', { createdAt: 3000 }));

    expect(await store.getAction('act_1')).toMatchObject({
      details: ['To: Teacher'],
      warnings: [],
      payload: { conversationId: 5 },
    });
    expect((await store.listActions(user.id, { limit: 10 })).map((a) => a.id)).toEqual(['act_3', 'act_2', 'act_1']);
    expect((await store.listActions(user.id, { limit: 10, status: 'pending' })).map((a) => a.id)).toEqual([
      'act_3',
      'act_1',
    ]);
    expect((await store.listActions(user.id, { limit: 1, before: 3000 })).map((a) => a.id)).toEqual(['act_2']);

    await store.updateAction('act_1', { status: 'executed', executedAt: 4000, result: 'done' });
    expect(await store.getAction('act_1')).toMatchObject({
      status: 'executed',
      executedAt: 4000,
      result: 'done',
      error: null,
    });
    await store.updateAction('act_1', { error: 'late' });
    expect((await store.getAction('act_1'))?.status).toBe('executed');
    expect(await store.getAction('nope')).toBeNull();
  });
});

describe('upload drafts', () => {
  it('appends files atomically and accumulates the byte total', async () => {
    await store.createUploadDraft({
      id: 'upl_1',
      userId: user.id,
      cmid: 55,
      draftItemId: 999,
      files: [],
      totalBytes: 0,
      createdAt: 1000,
      expiresAt: 2000,
    });
    await store.appendUploadedFile('upl_1', { name: 'a.pdf', size: 100, mime: 'application/pdf' });
    await store.appendUploadedFile('upl_1', { name: 'b.txt', size: 23, mime: null });
    const row = await store.getUploadDraft('upl_1');
    expect(row?.files).toEqual([
      { name: 'a.pdf', size: 100, mime: 'application/pdf' },
      { name: 'b.txt', size: 23, mime: null },
    ]);
    expect(row?.totalBytes).toBe(123);
    expect(await store.getUploadDraft('x')).toBeNull();
  });
});

describe('course snapshots', () => {
  const snap = (userId: number, courseId: number, over: Partial<CourseSnapshotRow> = {}): CourseSnapshotRow => ({
    userId,
    courseId,
    json: '{}',
    fetchedAt: 1,
    checkedAt: 1,
    ...over,
  });

  it('upserts per (user, course) and touch only moves checkedAt', async () => {
    await store.putCourseSnapshot(snap(user.id, 10, { json: '{"a":1}' }));
    await store.putCourseSnapshot(snap(user.id, 11, { json: '{"b":1}' }));
    await store.putCourseSnapshot(snap(user.id, 10, { json: '{"a":2}', fetchedAt: 5, checkedAt: 5 }));
    await store.touchCourseSnapshot(user.id, 11, 50);
    await store.touchCourseSnapshot(user.id, 404, 50); // unknown course: no-op
    expect(await store.getCourseSnapshots(user.id)).toEqual([
      snap(user.id, 10, { json: '{"a":2}', fetchedAt: 5, checkedAt: 5 }),
      snap(user.id, 11, { json: '{"b":1}', fetchedAt: 1, checkedAt: 50 }),
    ]);
  });

  it('listSweepUsers: active credentials only, never-swept users first, then the least recently swept', async () => {
    const mk = async (moodleUserId: number, status: 'active' | 'invalid' | null) => {
      const u = await store.upsertUser({ moodleUserId, fullname: `U${moodleUserId}`, lang: 'en' });
      if (status) await store.putCredential(credential(u.id, { status, tokenHash: `h${moodleUserId}` }));
      return u;
    };
    const fresh = await mk(2001, 'active');
    const stale = await mk(2002, 'active');
    await mk(2003, 'invalid');
    await mk(2004, null);
    const recent = await mk(2005, 'active');
    // old out-of-scope snapshots no longer decide the order: only the sweep stamp does
    await store.putCourseSnapshot(snap(fresh.id, 1, { checkedAt: 1 }));
    await store.markSwept(recent.id, 900);
    await store.markSwept(stale.id, 100);

    expect((await store.listSweepUsers(10)).map((u) => u.id)).toEqual([fresh.id, stale.id, recent.id]);
    const limited = await store.listSweepUsers(2);
    expect(limited.map((u) => u.id)).toEqual([fresh.id, stale.id]);
    expect(limited[0]).toMatchObject({ moodleUserId: 2001, settings: { myCourseIds: null } });
  });
});

describe('scope course ids', () => {
  const mk = async () => {
    const u = await store.upsertUser({ moodleUserId: 3001, fullname: 'U3001', lang: 'en' });
    await store.putCredential(credential(u.id, { tokenHash: 'h3001' }));
    return u;
  };
  const totalChanges = async () => (await t.db.prepare('SELECT total_changes() AS n').first<{ n: number }>())?.n ?? -1;

  it('are stored sorted and deduplicated, and come back with listSweepUsers', async () => {
    const u = await mk();
    expect((await store.listSweepUsers(5))[0]?.scopeCourseIds).toBeUndefined();
    await store.setScopeCourseIds(u.id, [30, 10, 30, 20]);
    expect((await store.listSweepUsers(5))[0]?.scopeCourseIds).toEqual([10, 20, 30]);
    await store.setScopeCourseIds(u.id, []);
    expect((await store.listSweepUsers(5))[0]?.scopeCourseIds).toEqual([]);
  });

  it('touch no row when the list did not change', async () => {
    const u = await mk();
    await store.setScopeCourseIds(u.id, [2, 1]);
    const before = await totalChanges();
    await store.setScopeCourseIds(u.id, [1, 2]);
    expect(await totalChanges()).toBe(before);
    await store.setScopeCourseIds(u.id, [1, 2, 3]);
    expect(await totalChanges()).toBe(before + 1);
  });

  it('ignore an unknown user and a corrupt stored value', async () => {
    const u = await mk();
    await store.setScopeCourseIds(404, [1]);
    await t.db.prepare('UPDATE users SET scope_course_ids = ? WHERE id = ?').bind('{oops', u.id).run();
    expect((await store.listSweepUsers(5))[0]?.scopeCourseIds).toBeUndefined();
  });
});

describe('inferred schedules', () => {
  const schedule = (checkedAt: number, slots: InferredSchedule['slots'] = []): InferredSchedule => ({
    slots,
    firstDate: slots.length ? '2026-10-02' : null,
    lastDate: slots.length ? '2027-01-22' : null,
    checkedAt,
  });
  const fri12 = { weekday: 5, periodFrom: 1, periodTo: 2, night: false, classroom: null };

  it('are stored per user and course, upserted, and an empty answer is kept', async () => {
    const other = await store.upsertUser({ moodleUserId: 2002, fullname: 'Hanako Sato', lang: 'ja' });
    expect((await store.getInferredSchedules(user.id)).size).toBe(0);
    await store.putInferredSchedules(
      user.id,
      new Map([
        [300907, schedule(1000, [fri12])],
        [9, schedule(1000)],
      ]),
    );
    await store.putInferredSchedules(other.id, new Map([[300907, schedule(5)]]));
    await store.putInferredSchedules(user.id, new Map([[9, schedule(2000, [fri12])]]));
    await store.putInferredSchedules(user.id, new Map());

    const mine = await store.getInferredSchedules(user.id);
    expect([...mine.keys()].sort((a, b) => a - b)).toEqual([9, 300907]);
    expect(mine.get(300907)).toEqual(schedule(1000, [fri12]));
    expect(mine.get(9)?.checkedAt).toBe(2000);
    expect((await store.getInferredSchedules(other.id)).get(300907)?.slots).toEqual([]);
  });

  it('treats an unreadable row as missing', async () => {
    await store.putInferredSchedules(user.id, new Map([[1, schedule(1)]]));
    await t.db.prepare('UPDATE inferred_schedules SET json = ? WHERE user_id = ?').bind('{oops', user.id).run();
    expect((await store.getInferredSchedules(user.id)).size).toBe(0);
  });
});

describe('syllabus cache', () => {
  it('is global, upserts per idnumber and returns only the requested hits (including cached "null")', async () => {
    await store.putSyllabusCache('2026570010006202', '{"term":"秋クォーター"}', 10);
    await store.putSyllabusCache('2026920015500116', 'null', 11);
    await store.putSyllabusCache('2026570010006202', '{"term":"夏クォーター"}', 20);

    const hit = await store.getSyllabusCache(['2026570010006202', '2026920015500116', 'missing', '2026570010006202']);
    expect(hit.size).toBe(2);
    expect(hit.get('2026570010006202')).toEqual({ json: '{"term":"夏クォーター"}', fetchedAt: 20 });
    expect(hit.get('2026920015500116')).toEqual({ json: 'null', fetchedAt: 11 });
    expect((await store.getSyllabusCache([])).size).toBe(0);
  });

  it('handles more ids than one statement can bind', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => `id${i}`);
    for (const id of ids) await store.putSyllabusCache(id, 'null', 1);
    expect((await store.getSyllabusCache(ids)).size).toBe(130);
  });
});

describe('audit', () => {
  it('lists newest first with a row-id cursor and parses detail JSON', async () => {
    await store.audit({ userId: user.id, at: 100, actor: 'console', action: 'a', detail: { n: 1 } });
    await store.audit({ userId: user.id, at: 200, actor: 'mcp:Claude', action: 'b', detail: null });
    await store.audit({ userId: user.id, at: 300, actor: 'system', action: 'c', detail: null });
    const all = await store.listAudit(user.id, { limit: 10 });
    expect(all.map((r) => r.action)).toEqual(['c', 'b', 'a']);
    expect(all[2]?.detail).toEqual({ n: 1 });
    const cursor = all[0]?.id;
    expect(cursor).toEqual(expect.any(Number));
    expect((await store.listAudit(user.id, { limit: 10, before: cursor })).map((r) => r.action)).toEqual(['b', 'a']);
    expect(await store.listAudit(user.id, { limit: 1 })).toHaveLength(1);
  });
});

describe('handoffs', () => {
  it('are single use and respect their expiry', async () => {
    await store.putHandoff({ codeHash: 'h1', payloadEnc: 'enc-1', createdAt: 1000, expiresAt: 5000 });
    await store.putHandoff({ codeHash: 'h2', payloadEnc: 'enc-2', createdAt: 1000, expiresAt: 5000 });
    expect(await store.takeHandoff('h1', 2000)).toBe('enc-1');
    expect(await store.takeHandoff('h1', 2000)).toBeNull(); // consumed
    expect(await store.takeHandoff('h2', 5000)).toBeNull(); // expired (and removed)
    expect(await store.takeHandoff('h2', 2000)).toBeNull();
    expect(await store.takeHandoff('missing', 2000)).toBeNull();
  });
});

describe('handoff peek', () => {
  it('reads without consuming and hides expired rows', async () => {
    await store.putHandoff({ codeHash: 'p1', payloadEnc: 'enc', createdAt: 1, expiresAt: 5000 });
    expect(await store.peekHandoff('p1', 2000)).toBe('enc');
    expect(await store.peekHandoff('p1', 2000)).toBe('enc');
    expect(await store.peekHandoff('p1', 5000)).toBeNull();
    expect(await store.takeHandoff('p1', 2000)).toBe('enc');
  });
});

describe('pending OAuth requests', () => {
  it('can be read repeatedly but taken only once, and expire', async () => {
    await store.putOAuthRequest({ id: 'req_1', payloadEnc: 'enc-1', createdAt: 1, expiresAt: 5000 });
    expect(await store.getOAuthRequest('req_1', 2000)).toBe('enc-1');
    expect(await store.getOAuthRequest('req_1', 2000)).toBe('enc-1');
    expect(await store.takeOAuthRequest('req_1', 2000)).toBe('enc-1');
    expect(await store.takeOAuthRequest('req_1', 2000)).toBeNull();
    await store.putOAuthRequest({ id: 'req_2', payloadEnc: 'enc-2', createdAt: 1, expiresAt: 5000 });
    expect(await store.getOAuthRequest('req_2', 5000)).toBeNull();
    expect(await store.takeOAuthRequest('req_2', 5000)).toBeNull();
  });
});

describe('rate limit counters', () => {
  it('count per key inside a fixed window and restart after it', async () => {
    expect(await store.hitRateLimit('k', 1000, 10_000)).toBe(1);
    expect(await store.hitRateLimit('k', 1000, 10_400)).toBe(2);
    expect(await store.hitRateLimit('other', 1000, 10_400)).toBe(1);
    expect(await store.hitRateLimit('k', 1000, 11_001)).toBe(1);
    expect(await store.hitRateLimit('k', 1000, 11_002)).toBe(2);
  });
});

describe('deleteUser', () => {
  it('removes the user and every dependent row, leaving other users alone', async () => {
    const other = await store.upsertUser({ moodleUserId: 2002, fullname: 'Hanako Sato', lang: 'ja' });
    for (const u of [user, other]) {
      await store.putCredential(credential(u.id));
      await store.createSession({
        idHash: `s${u.id}`,
        userId: u.id,
        createdAt: 1,
        expiresAt: 2,
        lastSeenAt: 1,
        userAgent: null,
      });
      await store.createApiKey(apiKey(u.id, `key_${u.id}`, `h${u.id}`));
      await store.createAction(action(u.id, `act_${u.id}`));
      await store.createUploadDraft({
        id: `upl_${u.id}`,
        userId: u.id,
        cmid: 1,
        draftItemId: 1,
        files: [],
        totalBytes: 0,
        createdAt: 1,
        expiresAt: 2,
      });
      await store.putCourseSnapshot({ userId: u.id, courseId: 1, json: '{}', fetchedAt: 1, checkedAt: 1 });
      const none = { slots: [], firstDate: null, lastDate: null, checkedAt: 1 };
      await store.putInferredSchedules(u.id, new Map([[1, none]]));
      await store.audit({ userId: u.id, at: 1, actor: 'console', action: 'x', detail: null });
    }
    await store.deleteUser(user.id);

    expect(await store.getUser(user.id)).toBeNull();
    for (const table of [
      'credentials',
      'sessions',
      'api_keys',
      'actions',
      'upload_drafts',
      'course_snapshots',
      'inferred_schedules',
      'audit',
    ]) {
      expect(count(table, user.id), table).toBe(0);
      expect(count(table, other.id), `${table} (other)`).toBe(1);
    }
  });
});

describe('purgeExpired', () => {
  it('applies the retention rules', async () => {
    const now = 10 * AUDIT_RETENTION_MS;
    await store.audit({ userId: user.id, at: now - AUDIT_RETENTION_MS - 1, actor: 'x', action: 'old', detail: null });
    await store.audit({ userId: user.id, at: now - 1000, actor: 'x', action: 'new', detail: null });
    await store.createSession({
      idHash: 'old',
      userId: user.id,
      createdAt: 1,
      expiresAt: now - 1,
      lastSeenAt: 1,
      userAgent: null,
    });
    await store.createSession({
      idHash: 'live',
      userId: user.id,
      createdAt: 1,
      expiresAt: now + 1,
      lastSeenAt: 1,
      userAgent: null,
    });
    await store.createAction(action(user.id, 'act_pending_old', { expiresAt: now - 1, createdAt: now - 5000 }));
    await store.createAction(
      action(user.id, 'act_done_old', { status: 'executed', createdAt: now - AUDIT_RETENTION_MS - 5 }),
    );
    await store.createUploadDraft({
      id: 'upl_old',
      userId: user.id,
      cmid: 1,
      draftItemId: 1,
      files: [],
      totalBytes: 0,
      createdAt: 1,
      expiresAt: now - 1,
    });

    await store.putHandoff({ codeHash: 'old', payloadEnc: 'x', createdAt: 1, expiresAt: now - 1 });
    await store.putHandoff({ codeHash: 'live', payloadEnc: 'x', createdAt: 1, expiresAt: now + 1 });
    await store.putOAuthRequest({ id: 'old', payloadEnc: 'x', createdAt: 1, expiresAt: now - 1 });
    await store.putOAuthRequest({ id: 'live', payloadEnc: 'x', createdAt: 1, expiresAt: now + 1 });
    await store.hitRateLimit('stale', 1000, now - 2 * 86_400_000);
    await store.hitRateLimit('fresh', 1000, now);
    await store.createApiKey({
      id: 'key_old',
      userId: user.id,
      name: 'old',
      prefix: 'wmm_0000',
      keyHash: 'h-old',
      scopes: ['moodle:read'],
      createdAt: 1,
      lastUsedAt: null,
      revokedAt: now - AUDIT_RETENTION_MS - 1,
    });
    await store.createApiKey({
      id: 'key_recent',
      userId: user.id,
      name: 'recent',
      prefix: 'wmm_1111',
      keyHash: 'h-recent',
      scopes: ['moodle:read'],
      createdAt: 1,
      lastUsedAt: null,
      revokedAt: now - 1000,
    });
    await store.putCourseSnapshot({ userId: user.id, courseId: 1, json: '{}', fetchedAt: 1, checkedAt: 1 });
    await store.putCourseSnapshot({ userId: user.id, courseId: 2, json: '{}', fetchedAt: 1, checkedAt: now - 1000 });

    await store.putSyllabusCache('old', 'null', now - 401 * 86_400_000);
    await store.putSyllabusCache('current', 'null', now - 86_400_000);

    const res = await store.purgeExpired(now);
    expect(res).toMatchObject({
      audit: 1,
      sessions: 1,
      uploadDrafts: 1,
      handoffs: 1,
      oauthRequests: 1,
      rateLimits: 1,
      revokedKeys: 1,
      actionsExpired: 1,
      actionsDeleted: 1,
      courseSnapshots: 1,
      syllabusCache: 1,
    });
    expect([...(await store.getSyllabusCache(['old', 'current'])).keys()]).toEqual(['current']);
    expect((await store.getCourseSnapshots(user.id)).map((r) => r.courseId)).toEqual([2]);
    expect(await store.takeHandoff('live', now)).toBe('x');
    expect(await store.getOAuthRequest('live', now)).toBe('x');
    expect((await store.listApiKeys(user.id)).map((k) => k.id)).toEqual(['key_recent']);
    expect((await store.listAudit(user.id, { limit: 10 })).map((r) => r.action)).toEqual(['new']);
    expect(await store.getSession('live')).not.toBeNull();
    expect((await store.getAction('act_pending_old'))?.status).toBe('expired');
    expect(await store.getAction('act_done_old')).toBeNull();
  });
});
