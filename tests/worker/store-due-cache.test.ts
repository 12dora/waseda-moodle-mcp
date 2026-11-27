/** Migration 0015 and the due-list copies of the console (store/due-cache.ts) on real SQLite. */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DueList } from '../../src/core/types';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 3, 17);
const KEY = 'days=14&overdue_days=&course_id=';

const list = (name: string) => ({ items: [{ name, courseId: 99101 }], truncated: false }) as unknown as DueList;
const count = (t: TestD1) => (t.sqlite.prepare('SELECT COUNT(*) AS n FROM due_cache').get() as { n: number }).n;

describe('migration 0015', () => {
  it('adds due_cache on top of the 0014 schema, keyed by user and query, cascading with the user', () => {
    const t = createTestD1(false);
    const names = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'));
    const apply = (pick: (n: string) => boolean) => {
      for (const name of names.filter(pick).sort()) t.sqlite.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
    };
    apply((n) => n < '0015');
    const table = () =>
      t.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'due_cache'").get();
    expect(table()).toBeUndefined();
    apply((n) => n.startsWith('0015'));
    expect(table()).toBeDefined();
    t.sqlite.exec(
      `INSERT INTO users (id, moodle_user_id, fullname, lang, settings, created_at) VALUES (1, 7001, 'U', 'en', '{}', 1)`,
    );
    const insert = t.sqlite.prepare('INSERT INTO due_cache (user_id, query, body, created_at) VALUES (?, ?, ?, ?)');
    insert.run(1, 'a', '{}', 1);
    insert.run(1, 'b', '{}', 1);
    expect(() => insert.run(1, 'a', '{}', 2)).toThrow();
    expect(() => insert.run(2, 'a', '{}', 1)).toThrow(); // no such user
    t.sqlite.exec('DELETE FROM users WHERE id = 1');
    expect(count(t)).toBe(0);
  });
});

describe('due cache store', () => {
  let t: TestD1;
  let store: D1Store;
  let userId: number;

  beforeEach(async () => {
    t = createTestD1();
    store = createD1Store(t.db);
    userId = (await store.upsertUser({ moodleUserId: 7001, fullname: 'Taro Yamada', lang: 'ja' })).id;
  });

  it('stores, replaces and reads one copy per query', async () => {
    expect(await store.getDueCache(userId, KEY)).toBeNull();
    await store.putDueCache(userId, KEY, { list: list('レポート１'), createdAt: 10 });
    await store.putDueCache(userId, KEY, { list: list('レポート２'), createdAt: 20 });
    await store.putDueCache(userId, 'days=7&overdue_days=&course_id=', { list: list('別'), createdAt: 15 });
    expect(await store.getDueCache(userId, KEY)).toEqual({ list: list('レポート２'), createdAt: 20 });
    expect(count(t)).toBe(2);
  });

  it('treats a row that no longer parses as missing', async () => {
    t.sqlite
      .prepare('INSERT INTO due_cache (user_id, query, body, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, KEY, '{not json', 1);
    expect(await store.getDueCache(userId, KEY)).toBeNull();
  });

  it('is deleted with the account', async () => {
    await store.putDueCache(userId, KEY, { list: list('x'), createdAt: 1 });
    await store.deleteUser(userId);
    expect(count(t)).toBe(0);
  });

  it('drops copies older than 7 days in the daily purge', async () => {
    await store.putDueCache(userId, KEY, { list: list('old'), createdAt: NOW - 8 * DAY });
    await store.putDueCache(userId, 'recent', { list: list('recent'), createdAt: NOW - 6 * DAY });
    expect(await store.purgeExpired(NOW)).toMatchObject({ dueCache: 1 });
    expect(await store.getDueCache(userId, KEY)).toBeNull();
    expect((await store.getDueCache(userId, 'recent'))?.list.items[0]?.name).toBe('recent');
  });
});
