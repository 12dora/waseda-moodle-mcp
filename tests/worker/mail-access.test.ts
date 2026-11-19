import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MailCredentialRow, UserRow } from '../../src/core/context';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const READ = 'https://www.googleapis.com/auth/gmail.readonly';

let t: TestD1;
let store: D1Store;
let user: UserRow;
let other: UserRow;

function credential(userId: number, over: Partial<MailCredentialRow> = {}): MailCredentialRow {
  return {
    userId,
    address: 'taro@akane.waseda.jp',
    googleSub: 'sub-1',
    refreshEnc: 'enc-1',
    scopes: [READ],
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

describe('mail access store', () => {
  it('request: none and rejected become pending; pending and approved stay', async () => {
    expect(await store.getMailAccess(user.id)).toBeNull();
    const pending = { userId: user.id, status: 'pending', requestedAt: 10, decidedAt: null, decidedBy: null };
    expect(await store.requestMailAccess(user.id, 10)).toEqual(pending);
    expect(await store.requestMailAccess(user.id, 20)).toEqual(pending);
    expect(await store.getMailAccess(user.id)).toEqual(pending);

    const approve = { status: 'approved', by: 9001, at: 30, from: ['pending'] } as const;
    expect(await store.decideMailAccess(user.id, approve)).toBe(true);
    const approved = { ...pending, status: 'approved', decidedAt: 30, decidedBy: 9001 };
    expect(await store.requestMailAccess(user.id, 40)).toEqual(approved);

    const reject = { status: 'rejected', by: 9002, at: 50, from: ['approved'] } as const;
    expect(await store.decideMailAccess(user.id, reject)).toBe(true);
    const rejected = { ...approved, status: 'rejected', decidedAt: 50, decidedBy: 9002 };
    expect(await store.getMailAccess(user.id)).toEqual(rejected);
    expect(await store.requestMailAccess(user.id, 60)).toEqual({ ...pending, requestedAt: 60 });
  });

  it('decide with `from` only touches an existing row in one of those states', async () => {
    const early = { status: 'approved', by: 9001, at: 1, from: ['pending'] } as const;
    expect(await store.decideMailAccess(user.id, early)).toBe(false);
    expect(await store.getMailAccess(user.id)).toBeNull();

    await store.requestMailAccess(user.id, 10);
    expect(await store.decideMailAccess(user.id, { status: 'approved', by: 9001, at: 20, from: ['rejected'] })).toBe(
      false,
    );
    expect(await store.decideMailAccess(user.id, { status: 'approved', by: 9001, at: 20, from: [] })).toBe(false);
    expect((await store.getMailAccess(user.id))?.status).toBe('pending');
    const from = ['pending', 'rejected'] as const;
    expect(await store.decideMailAccess(user.id, { status: 'approved', by: 9001, at: 20, from })).toBe(true);
    expect((await store.getMailAccess(user.id))?.status).toBe('approved');
  });

  it('decide with `from` null applies in any state and creates a missing row', async () => {
    expect(await store.decideMailAccess(user.id, { status: 'rejected', by: 9001, at: 7, from: null })).toBe(true);
    expect(await store.getMailAccess(user.id)).toEqual({
      userId: user.id,
      status: 'rejected',
      requestedAt: 7,
      decidedAt: 7,
      decidedBy: 9001,
    });
    await store.requestMailAccess(other.id, 3);
    await store.decideMailAccess(other.id, { status: 'approved', by: 9001, at: 4, from: null });
    expect(await store.decideMailAccess(other.id, { status: 'rejected', by: 9002, at: 8, from: null })).toBe(true);
    expect(await store.getMailAccess(other.id)).toMatchObject({ status: 'rejected', requestedAt: 3, decidedAt: 8 });
  });

  it('lists applicants with their connection, newest request first, filtered and limited; counts', async () => {
    const third = await store.upsertUser({ moodleUserId: 1003, fullname: 'Jiro Suzuki', lang: 'en' });
    await store.requestMailAccess(user.id, 10);
    await store.requestMailAccess(other.id, 30);
    await store.requestMailAccess(third.id, 20);
    await store.decideMailAccess(user.id, { status: 'approved', by: 9001, at: 40, from: null });
    await store.putMailCredential(credential(user.id, { status: 'invalid' }));

    const all = await store.listMailAccess({ limit: 10, except: [] });
    expect(all.map((r) => r.userId)).toEqual([other.id, third.id, user.id]);
    expect(all[2]).toEqual({
      userId: user.id,
      fullname: 'Taro Yamada',
      moodleUserId: 1001,
      status: 'approved',
      requestedAt: 10,
      decidedAt: 40,
      connection: { address: 'taro@akane.waseda.jp', status: 'invalid' },
    });
    expect(all[0]?.connection).toBeNull();

    const pending = await store.listMailAccess({ status: 'pending', limit: 10, except: [] });
    expect(pending.map((r) => r.userId)).toEqual([other.id, third.id]);
    expect(await store.listMailAccess({ status: 'pending', limit: 1, except: [] })).toHaveLength(1);
    expect(await store.listMailAccess({ status: 'rejected', limit: 10, except: [] })).toEqual([]);

    expect(await store.countMailAccess('pending', [])).toBe(2);
    expect(await store.countMailAccess('approved', [])).toBe(1);
    expect(await store.countMailAccess('rejected', [])).toBe(0);

    // the excepted Moodle users (operators) are left out of both
    const without = await store.listMailAccess({ status: 'pending', limit: 10, except: [1002, 4242] });
    expect(without.map((r) => r.userId)).toEqual([third.id]);
    expect(await store.countMailAccess('pending', [1002, 4242])).toBe(1);
    expect(await store.countMailAccess('approved', [1001])).toBe(0);
  });

  it('lists the owners of a mail credential whose access is missing or not approved', async () => {
    const third = await store.upsertUser({ moodleUserId: 1003, fullname: 'Jiro Suzuki', lang: 'en' });
    const fourth = await store.upsertUser({ moodleUserId: 1004, fullname: 'Saburo Ito', lang: 'en' });
    for (const u of [user, other, third, fourth]) await store.putMailCredential(credential(u.id));
    await store.decideMailAccess(other.id, { status: 'approved', by: 9001, at: 1, from: null });
    await store.decideMailAccess(third.id, { status: 'rejected', by: 9001, at: 1, from: null });
    await store.requestMailAccess(fourth.id, 1);
    const noCredential = await store.upsertUser({ moodleUserId: 1005, fullname: 'Shiro Kato', lang: 'en' });
    await store.requestMailAccess(noCredential.id, 1);

    expect(await store.listUnapprovedMailOwners(10)).toEqual([
      { userId: user.id, moodleUserId: 1001 },
      { userId: third.id, moodleUserId: 1003 },
      { userId: fourth.id, moodleUserId: 1004 },
    ]);
    expect(await store.listUnapprovedMailOwners(1)).toEqual([{ userId: user.id, moodleUserId: 1001 }]);
  });

  it('deleteUser removes the application', async () => {
    await store.requestMailAccess(user.id, 10);
    await store.deleteUser(user.id);
    expect(await store.getMailAccess(user.id)).toBeNull();
    expect(await store.countMailAccess('pending', [])).toBe(0);
  });
});

describe('migration 0013', () => {
  it('approves every user who already has a mail connection', async () => {
    const d1 = createTestD1(false);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith('.sql'))
      .sort();
    const exec = (f: string) => d1.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    for (const f of files.filter((n) => n < '0013')) exec(f);

    const s = createD1Store(d1.db);
    const a = await s.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
    const b = await s.upsertUser({ moodleUserId: 1002, fullname: 'Hanako Sato', lang: 'ja' });
    const c = await s.upsertUser({ moodleUserId: 1003, fullname: 'Jiro Suzuki', lang: 'ja' });
    await s.putMailCredential(credential(a.id, { connectedAt: 1234 }));
    await s.putMailCredential(credential(b.id, { connectedAt: 5678, status: 'invalid', refreshEnc: null }));

    for (const f of files.filter((n) => n >= '0013')) exec(f);
    const approved = { status: 'approved', decidedBy: null };
    expect(await s.getMailAccess(a.id)).toEqual({ userId: a.id, requestedAt: 1234, decidedAt: 1234, ...approved });
    expect(await s.getMailAccess(b.id)).toEqual({ userId: b.id, requestedAt: 5678, decidedAt: 5678, ...approved });
    expect(await s.getMailAccess(c.id)).toBeNull();

    // re-running keeps decisions made since
    await s.decideMailAccess(a.id, { status: 'rejected', by: 9001, at: 9999, from: null });
    exec(files.find((n) => n.startsWith('0013')) ?? '');
    expect((await s.getMailAccess(a.id))?.status).toBe('rejected');
  });
});
