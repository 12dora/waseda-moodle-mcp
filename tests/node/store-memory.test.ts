import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionRow, CredentialRow } from '../../src/core/context';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import { MemoryStore } from '../../src/node/store-memory';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wmm-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const action = (patch: Partial<ActionRow> = {}): ActionRow => ({
  id: 'act_1',
  userId: 1,
  kind: 'message',
  status: 'pending',
  approval: 'chat',
  title: 'Send message',
  details: ['to Alice'],
  warnings: [],
  payload: { text: 'hi' },
  source: 'Local',
  createdAt: 1000,
  expiresAt: 5000,
  executedAt: null,
  result: null,
  error: null,
  ...patch,
});

const credential = (userId: number): CredentialRow => ({
  userId,
  tokenEnc: 'enc',
  privateTokenEnc: null,
  tokenHash: 'h',
  tokenHint: 'abcd',
  status: 'active',
  connectedVia: 'stdio',
  connectedAt: 1,
  lastOkAt: null,
  lastError: null,
});

describe('MemoryStore users', () => {
  it('upserts by moodle id with default settings and returns copies', async () => {
    const s = new MemoryStore();
    const a = await s.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
    expect(a.id).toBe(1);
    expect(a.settings).toEqual(DEFAULT_SETTINGS);
    a.settings.hiddenCourseIds.push(9); // mutating the copy must not leak
    const b = await s.upsertUser({ moodleUserId: 1001, fullname: 'Taro Y.', lang: 'en' });
    expect(b.id).toBe(1);
    expect(b.fullname).toBe('Taro Y.');
    expect(b.settings.hiddenCourseIds).toEqual([]);
    const c = await s.upsertUser({ moodleUserId: 1002, fullname: 'Hanako', lang: 'ja' });
    expect(c.id).toBe(2);
    expect((await s.getUserByMoodleId(1002))?.id).toBe(2);
    expect(await s.getUser(99)).toBeNull();
  });

  it('updates settings and deletes every dependent row', async () => {
    const s = new MemoryStore();
    const u = await s.upsertUser({ moodleUserId: 1001, fullname: 'Taro', lang: 'en' });
    await s.updateSettings(u.id, { ...DEFAULT_SETTINGS, writeMode: 'off', hiddenCourseIds: [5] });
    expect((await s.getUser(u.id))?.settings).toMatchObject({ writeMode: 'off', hiddenCourseIds: [5] });

    await s.putCredential(credential(u.id));
    await s.createAction(action({ userId: u.id }));
    await s.putCourseIndex({ userId: u.id, courseId: 1, json: '{}', updatedAt: 1 });
    await s.audit({ userId: u.id, at: 1, actor: 'x', action: 'y', detail: null });
    await s.deleteUser(u.id);
    expect(await s.getUser(u.id)).toBeNull();
    expect(await s.getCredential(u.id)).toBeNull();
    expect(await s.getAction('act_1')).toBeNull();
    expect(await s.getCourseIndex(u.id)).toEqual([]);
    expect(await s.listAudit(u.id, { limit: 10 })).toEqual([]);
  });
});

describe('MemoryStore credential, sessions, keys', () => {
  it('updates credential status partially', async () => {
    const s = new MemoryStore();
    await s.putCredential(credential(1));
    await s.updateCredentialStatus(1, { status: 'invalid', lastError: 'expired' });
    expect(await s.getCredential(1)).toMatchObject({ status: 'invalid', lastError: 'expired', lastOkAt: null });
    await s.updateCredentialStatus(1, { lastOkAt: 7 });
    expect((await s.getCredential(1))?.lastOkAt).toBe(7);
  });

  it('manages sessions', async () => {
    const s = new MemoryStore();
    await s.createSession({ idHash: 'h1', userId: 1, createdAt: 1, expiresAt: 10, lastSeenAt: 1, userAgent: null });
    await s.createSession({ idHash: 'h2', userId: 1, createdAt: 1, expiresAt: 10, lastSeenAt: 1, userAgent: null });
    await s.touchSession('h1', 5, 50);
    expect(await s.getSession('h1')).toMatchObject({ lastSeenAt: 5, expiresAt: 50 });
    await s.deleteSession('h1');
    expect(await s.getSession('h1')).toBeNull();
    await s.deleteUserSessions(1);
    expect(await s.getSession('h2')).toBeNull();
  });

  it('lists keys newest first, hides revoked ones from hash lookup', async () => {
    const s = new MemoryStore();
    const base = {
      userId: 1,
      name: 'k',
      prefix: 'wmm_',
      scopes: ['moodle:read' as const],
      lastUsedAt: null,
      revokedAt: null,
    };
    await s.createApiKey({ ...base, id: 'key_a', keyHash: 'ha', createdAt: 1 });
    await s.createApiKey({ ...base, id: 'key_b', keyHash: 'hb', createdAt: 2 });
    expect((await s.listApiKeys(1)).map((k) => k.id)).toEqual(['key_b', 'key_a']);
    expect(await s.revokeApiKey(2, 'key_a', 9)).toBe(false); // someone else's
    expect(await s.revokeApiKey(1, 'key_a', 9)).toBe(true);
    expect(await s.revokeApiKey(1, 'key_a', 9)).toBe(false);
    expect(await s.getApiKeyByHash('ha')).toBeNull();
    expect((await s.getApiKeyByHash('hb'))?.id).toBe('key_b');
    await s.touchApiKey('key_b', 77);
    expect((await s.listApiKeys(1))[0]?.lastUsedAt).toBe(77);
  });
});

describe('MemoryStore actions, uploads, audit', () => {
  it('filters and orders actions', async () => {
    const s = new MemoryStore();
    await s.createAction(action({ id: 'a1', createdAt: 1 }));
    await s.createAction(action({ id: 'a2', createdAt: 2, status: 'executed' }));
    await s.createAction(action({ id: 'a3', createdAt: 3, userId: 2 }));
    expect((await s.listActions(1, { limit: 10 })).map((a) => a.id)).toEqual(['a2', 'a1']);
    expect((await s.listActions(1, { limit: 10, status: 'pending' })).map((a) => a.id)).toEqual(['a1']);
    expect((await s.listActions(1, { limit: 10, before: 2 })).map((a) => a.id)).toEqual(['a1']);
    expect(await s.listActions(1, { limit: 1 })).toHaveLength(1);
    await s.updateAction('a1', { status: 'executed', executedAt: 9, result: 'ok' });
    expect(await s.getAction('a1')).toMatchObject({ status: 'executed', executedAt: 9, result: 'ok', error: null });
  });

  it('claims a pending, unexpired, owned action exactly once', async () => {
    const s = new MemoryStore();
    await s.createAction(action({ id: 'a1', expiresAt: 5000 }));
    expect(await s.claimAction('a1', 2, 1000)).toBe(false); // not the owner
    expect(await s.claimAction('a1', 1, 6000)).toBe(false); // expired
    expect(await s.claimAction('missing', 1, 1000)).toBe(false);
    expect(await Promise.all([s.claimAction('a1', 1, 1000), s.claimAction('a1', 1, 1000)])).toEqual([true, false]);
    expect((await s.getAction('a1'))?.status).toBe('executing');
    await s.updateAction('a1', { status: 'executed' });
    expect(await s.claimAction('a1', 1, 1000)).toBe(false);
  });

  it('consumes an upload draft once', async () => {
    const s = new MemoryStore();
    const row = { id: 'upl_1', userId: 1, cmid: 5, draftItemId: 42, files: [], totalBytes: 0, createdAt: 1 };
    await s.createUploadDraft({ ...row, expiresAt: Date.now() + 60_000 });
    await s.createUploadDraft({ ...row, id: 'upl_old', expiresAt: Date.now() - 1 });
    expect(await s.consumeUploadDraft('upl_1')).toBe(true);
    expect(await s.consumeUploadDraft('upl_1')).toBe(false);
    expect(await s.consumeUploadDraft('upl_old')).toBe(false);
    expect(await s.consumeUploadDraft('nope')).toBe(false);
    expect((await s.getUploadDraft('upl_1'))?.expiresAt).toBeLessThanOrEqual(Date.now());
  });

  it('appends uploaded files and totals', async () => {
    const s = new MemoryStore();
    await s.createUploadDraft({
      id: 'upl_1',
      userId: 1,
      cmid: 5,
      draftItemId: 42,
      files: [],
      totalBytes: 0,
      createdAt: 1,
      expiresAt: 9,
    });
    await s.appendUploadedFile('upl_1', { name: 'a.pdf', size: 10, mime: 'application/pdf' });
    await s.appendUploadedFile('upl_1', { name: 'b.pdf', size: 5, mime: null });
    const d = await s.getUploadDraft('upl_1');
    expect(d?.files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(d?.totalBytes).toBe(15);
  });

  it('stores one course index row per course and returns audit newest first', async () => {
    const s = new MemoryStore();
    await s.putCourseIndex({ userId: 1, courseId: 7, json: 'old', updatedAt: 1 });
    await s.putCourseIndex({ userId: 1, courseId: 7, json: 'new', updatedAt: 2 });
    await s.putCourseIndex({ userId: 2, courseId: 7, json: 'other', updatedAt: 2 });
    expect((await s.getCourseIndex(1)).map((r) => r.json)).toEqual(['new']);

    for (let i = 1; i <= 3; i++) await s.audit({ userId: 1, at: i * 10, actor: 'a', action: `t${i}`, detail: { i } });
    expect((await s.listAudit(1, { limit: 2 })).map((r) => r.action)).toEqual(['t3', 't2']);
    expect((await s.listAudit(1, { limit: 5, before: 30 })).map((r) => r.action)).toEqual(['t2', 't1']);
  });
});

describe('MemoryStore persistence', () => {
  it('round-trips users (settings) and actions but not credentials', async () => {
    const path = join(dir, 'sub', 'state.json');
    const a = new MemoryStore({ persistPath: path });
    const u = await a.upsertUser({ moodleUserId: 1001, fullname: 'Taro', lang: 'en' });
    await a.updateSettings(u.id, { ...DEFAULT_SETTINGS, writeMode: 'off', hiddenCourseIds: [3] });
    await a.createAction(action({ userId: u.id }));
    await a.putCredential(credential(u.id));
    await a.flush();

    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('tokenEnc');

    const b = new MemoryStore({ persistPath: path });
    const again = await b.upsertUser({ moodleUserId: 1001, fullname: 'Taro', lang: 'en' });
    expect(again.id).toBe(u.id);
    expect(again.settings).toMatchObject({ writeMode: 'off', hiddenCourseIds: [3] });
    expect((await b.getAction('act_1'))?.title).toBe('Send message');
    expect(await b.getCredential(u.id)).toBeNull();
    const next = await b.upsertUser({ moodleUserId: 1002, fullname: 'Hanako', lang: 'ja' });
    expect(next.id).toBe(u.id + 1);
  });

  it('survives a corrupt file and reports it', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, '{not json');
    const errors: unknown[] = [];
    const s = new MemoryStore({ persistPath: path, onPersistError: (e) => errors.push(e) });
    expect(errors).toHaveLength(1);
    expect((await s.upsertUser({ moodleUserId: 1, fullname: 'T', lang: 'en' })).id).toBe(1);
    await s.flush();
    expect(JSON.parse(readFileSync(path, 'utf8')).users).toHaveLength(1);
  });
});
