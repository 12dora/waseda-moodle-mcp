import { beforeEach, describe, expect, it } from 'vitest';
import type { MailCredentialRow, UserRow } from '../../src/core/context';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';

let t: TestD1;
let store: D1Store;
let user: UserRow;
let other: UserRow;

type Row = Record<string, unknown>;

const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const SEND = 'https://www.googleapis.com/auth/gmail.send';

function row(userId: number, over: Partial<MailCredentialRow> = {}): MailCredentialRow {
  return {
    userId,
    address: 'taro@akane.waseda.jp',
    googleSub: 'sub-1',
    refreshEnc: 'enc-1',
    scopes: ['openid', READ, SEND],
    status: 'active',
    connectedAt: 1000,
    lastUsedAt: null,
    lastError: null,
    idleTriedAt: null,
    ...over,
  };
}

beforeEach(async () => {
  t = createTestD1();
  store = createD1Store(t.db);
  user = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
  other = await store.upsertUser({ moodleUserId: 1002, fullname: 'Hanako Sato', lang: 'ja' });
});

describe('mail credentials', () => {
  it('stores, replaces, patches and deletes one row per user', async () => {
    expect(await store.getMailCredential(user.id)).toBeNull();
    await store.putMailCredential(row(user.id));
    expect(await store.getMailCredential(user.id)).toEqual(row(user.id));
    const raw = t.sqlite.prepare('SELECT scopes FROM mail_credentials WHERE user_id = ?').get(user.id) as Row;
    expect(raw.scopes).toBe(`openid ${READ} ${SEND}`);

    // a reconnect replaces every column
    const next = row(user.id, { address: 'jiro@akane.waseda.jp', refreshEnc: 'enc-2', scopes: [READ], connectedAt: 5 });
    await store.putMailCredential({ ...next, status: 'invalid', lastUsedAt: 9, lastError: 'x', idleTriedAt: 3 });
    await store.putMailCredential({ ...next, googleSub: 'sub-9' });
    await store.putMailCredential(next);
    expect(await store.getMailCredential(user.id)).toEqual(next);

    await store.updateMailCredential(user.id, { lastUsedAt: 7000 });
    expect(await store.getMailCredential(user.id)).toMatchObject({ lastUsedAt: 7000, refreshEnc: 'enc-2' });
    await store.updateMailCredential(user.id, { status: 'invalid', refreshEnc: null, lastError: 'Idle.' });
    expect(await store.getMailCredential(user.id)).toMatchObject({
      status: 'invalid',
      refreshEnc: null,
      lastError: 'Idle.',
      lastUsedAt: 7000,
    });
    await store.updateMailCredential(user.id, {}); // nothing to set
    await store.updateMailCredential(user.id, { idleTriedAt: 42 });
    expect((await store.getMailCredential(user.id))?.idleTriedAt).toBe(42);

    expect(await store.deleteMailCredential(user.id)).toBe(true);
    expect(await store.deleteMailCredential(user.id)).toBe(false);
    expect(await store.getMailCredential(user.id)).toBeNull();
  });

  it('deleteUser removes the connection but keeps the slot', async () => {
    await store.putMailCredential(row(user.id));
    await store.takeMailSlot(user.moodleUserId, 1, null);
    await store.deleteUser(user.id);
    expect(await store.getMailCredential(user.id)).toBeNull();
    expect(await store.hasMailSlot(user.moodleUserId)).toBe(true);
  });

  it('lists idle active connections, oldest last use first', async () => {
    const third = await store.upsertUser({ moodleUserId: 1003, fullname: 'Jiro Suzuki', lang: 'ja' });
    const fourth = await store.upsertUser({ moodleUserId: 1004, fullname: 'Saburo Ito', lang: 'ja' });
    await store.putMailCredential(row(user.id, { connectedAt: 100, lastUsedAt: 500 })); // used at 500
    await store.putMailCredential(row(other.id, { connectedAt: 200, lastUsedAt: null })); // never used: 200
    await store.putMailCredential(row(third.id, { connectedAt: 100, lastUsedAt: 2000 })); // recent
    await store.putMailCredential(row(fourth.id, { connectedAt: 50, status: 'invalid', refreshEnc: null }));

    const idle = await store.listIdleMailCredentials(1000, 10);
    expect(idle.map((r) => r.userId)).toEqual([other.id, user.id]);
    expect((await store.listIdleMailCredentials(1000, 1)).map((r) => r.userId)).toEqual([other.id]);
    expect(await store.listIdleMailCredentials(150, 10)).toEqual([]);
    expect((await store.listIdleMailCredentials(500, 10)).map((r) => r.userId)).toEqual([other.id, user.id]);

    // a row the cleanup failed on goes behind the others; among tried rows the longest ago first
    await store.updateMailCredential(other.id, { idleTriedAt: 900 });
    expect((await store.listIdleMailCredentials(1000, 1)).map((r) => r.userId)).toEqual([user.id]);
    await store.updateMailCredential(user.id, { idleTriedAt: 950 });
    expect((await store.listIdleMailCredentials(1000, 10)).map((r) => r.userId)).toEqual([other.id, user.id]);

    // active but without a token is not listed either
    await store.updateMailCredential(other.id, { refreshEnc: null });
    expect((await store.listIdleMailCredentials(1000, 10)).map((r) => r.userId)).toEqual([user.id]);
  });

  it('updateMailCredentialIf applies only while the row holds the expected token', async () => {
    await store.putMailCredential(row(user.id));
    expect(await store.updateMailCredentialIf(user.id, { refreshEnc: 'enc-old' }, { status: 'invalid' })).toBe(false);
    expect((await store.getMailCredential(user.id))?.status).toBe('active');
    const patch = { status: 'invalid', refreshEnc: null, lastError: 'Idle.' } as const;
    expect(await store.updateMailCredentialIf(user.id, { refreshEnc: 'enc-1' }, patch)).toBe(true);
    expect(await store.getMailCredential(user.id)).toMatchObject(patch);
    // a null token matches a revoked row; nothing to set reports false
    expect(await store.updateMailCredentialIf(user.id, { refreshEnc: null }, { idleTriedAt: 5 })).toBe(true);
    expect(await store.updateMailCredentialIf(user.id, { refreshEnc: null }, {})).toBe(false);
    expect(await store.updateMailCredentialIf(other.id, { refreshEnc: null }, { idleTriedAt: 5 })).toBe(false);
  });
});

describe('mail slots', () => {
  it('counts distinct Moodle users; taking twice changes nothing', async () => {
    expect(await store.countMailSlots()).toBe(0);
    expect(await store.hasMailSlot(1001)).toBe(false);
    expect(await store.takeMailSlot(1001, 10, null)).toBe(true);
    expect(await store.takeMailSlot(1001, 20, null)).toBe(true);
    expect(await store.takeMailSlot(1002, 30, null)).toBe(true);
    expect(await store.countMailSlots()).toBe(2);
    expect(await store.hasMailSlot(1001)).toBe(true);
    expect(await store.hasMailSlot(1003)).toBe(false);
    const first = t.sqlite.prepare('SELECT created_at FROM mail_slots WHERE moodle_user_id = 1001').get() as Row;
    expect(first.created_at).toBe(10);
  });

  it('takes a new slot only below the limit, in one statement; a holder keeps theirs', async () => {
    expect(await store.takeMailSlot(1001, 10, 2)).toBe(true);
    expect(await store.takeMailSlot(1002, 20, 2)).toBe(true);
    expect(await store.takeMailSlot(1003, 30, 2)).toBe(false);
    expect(await store.hasMailSlot(1003)).toBe(false);
    expect(await store.takeMailSlot(1001, 40, 2)).toBe(true);
    // limit 0: no new slots, holders still pass
    expect(await store.takeMailSlot(1004, 50, 0)).toBe(false);
    expect(await store.takeMailSlot(1002, 60, 0)).toBe(true);
    expect(await store.countMailSlots()).toBe(2);
    const first = t.sqlite.prepare('SELECT created_at FROM mail_slots WHERE moodle_user_id = 1001').get() as Row;
    expect(first.created_at).toBe(10);
  });
});
