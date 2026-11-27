/** Migration 0016 and the console's answer copies (store/console-cache.ts) on real SQLite. */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 3, 17);
const DUE_KEY = '/api/due?days=14&overdue_days=&course_id=';
const COURSES_KEY = '/api/courses?';

const body = (name: string) => ({ items: [{ name, courseId: 99101 }], truncated: false });
const count = (t: TestD1) => (t.sqlite.prepare('SELECT COUNT(*) AS n FROM console_cache').get() as { n: number }).n;
const sqlNames = (t: TestD1, type: string) =>
  (t.sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as { name: string }[]).map(
    (r) => r.name,
  );

describe('migration 0016', () => {
  it('renames due_cache to console_cache on top of 0001-0015, keeping its rows under route-prefixed keys', () => {
    const t = createTestD1(false);
    const names = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'));
    const apply = (pick: (n: string) => boolean) => {
      for (const name of names.filter(pick).sort()) t.sqlite.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
    };
    apply((n) => n < '0016');
    t.sqlite.exec(
      `INSERT INTO users (id, moodle_user_id, fullname, lang, settings, created_at) VALUES (1, 7001, 'U', 'en', '{}', 1)`,
    );
    t.sqlite
      .prepare('INSERT INTO due_cache (user_id, query, body, created_at) VALUES (?, ?, ?, ?)')
      .run(1, 'days=14&overdue_days=&course_id=', '{"items":[]}', 5);

    apply((n) => n.startsWith('0016'));
    expect(sqlNames(t, 'table')).toContain('console_cache');
    expect(sqlNames(t, 'table')).not.toContain('due_cache');
    expect(sqlNames(t, 'index')).toContain('idx_console_cache_created');
    expect(sqlNames(t, 'index')).not.toContain('idx_due_cache_created');
    expect(t.sqlite.prepare('SELECT user_id, cache_key, body, created_at FROM console_cache').all()).toEqual([
      { user_id: 1, cache_key: DUE_KEY, body: '{"items":[]}', created_at: 5 },
    ]);

    const insert = t.sqlite.prepare(
      'INSERT INTO console_cache (user_id, cache_key, body, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run(1, COURSES_KEY, '{}', 1);
    expect(() => insert.run(1, COURSES_KEY, '{}', 2)).toThrow(); // one copy per user and key
    expect(() => insert.run(2, COURSES_KEY, '{}', 1)).toThrow(); // no such user
    t.sqlite.exec('DELETE FROM users WHERE id = 1');
    expect(count(t)).toBe(0);
  });
});

describe('console cache store', () => {
  let t: TestD1;
  let store: D1Store;
  let userId: number;
  let otherId: number;

  beforeEach(async () => {
    t = createTestD1();
    store = createD1Store(t.db);
    userId = (await store.upsertUser({ moodleUserId: 7001, fullname: 'Taro Yamada', lang: 'ja' })).id;
    otherId = (await store.upsertUser({ moodleUserId: 7002, fullname: 'Hanako Suzuki', lang: 'ja' })).id;
  });

  it('stores, replaces and reads one copy per key', async () => {
    expect(await store.getConsoleCache(userId, DUE_KEY)).toBeNull();
    await store.putConsoleCache(userId, DUE_KEY, { body: body('レポート１'), createdAt: 10 });
    await store.putConsoleCache(userId, DUE_KEY, { body: body('レポート２'), createdAt: 20 });
    await store.putConsoleCache(userId, COURSES_KEY, { body: { mode: 'auto', courses: [] }, createdAt: 15 });
    expect(await store.getConsoleCache(userId, DUE_KEY)).toEqual({ body: body('レポート２'), createdAt: 20 });
    expect(await store.getConsoleCache(userId, COURSES_KEY)).toEqual({
      body: { mode: 'auto', courses: [] },
      createdAt: 15,
    });
    expect(count(t)).toBe(2);
  });

  it('treats a row that does not parse as a JSON object as missing', async () => {
    const insert = t.sqlite.prepare(
      'INSERT INTO console_cache (user_id, cache_key, body, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run(userId, 'a', '{not json', 1);
    insert.run(userId, 'b', '[1,2]', 1);
    insert.run(userId, 'c', 'null', 1);
    for (const key of ['a', 'b', 'c']) expect(await store.getConsoleCache(userId, key), key).toBeNull();
  });

  it('clears every copy of one user only', async () => {
    await store.putConsoleCache(userId, DUE_KEY, { body: body('x'), createdAt: 1 });
    await store.putConsoleCache(userId, COURSES_KEY, { body: body('y'), createdAt: 1 });
    await store.putConsoleCache(otherId, DUE_KEY, { body: body('z'), createdAt: 1 });
    await store.clearConsoleCache(userId);
    expect(await store.getConsoleCache(userId, DUE_KEY)).toBeNull();
    expect(await store.getConsoleCache(userId, COURSES_KEY)).toBeNull();
    expect((await store.getConsoleCache(otherId, DUE_KEY))?.body).toEqual(body('z'));
  });

  it('is deleted with the account', async () => {
    await store.putConsoleCache(userId, DUE_KEY, { body: body('x'), createdAt: 1 });
    await store.deleteUser(userId);
    expect(count(t)).toBe(0);
  });

  it('drops copies older than 7 days in the daily purge', async () => {
    await store.putConsoleCache(userId, DUE_KEY, { body: body('old'), createdAt: NOW - 8 * DAY });
    await store.putConsoleCache(userId, COURSES_KEY, { body: body('recent'), createdAt: NOW - 6 * DAY });
    expect(await store.purgeExpired(NOW)).toMatchObject({ consoleCache: 1 });
    expect(await store.getConsoleCache(userId, DUE_KEY)).toBeNull();
    expect((await store.getConsoleCache(userId, COURSES_KEY))?.body).toEqual(body('recent'));
  });
});
