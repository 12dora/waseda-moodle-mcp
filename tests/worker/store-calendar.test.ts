import { beforeEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/core/context';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';

let t: TestD1;
let store: D1Store;
let user: UserRow;

const feedRows = (): number => (t.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_feeds').get() as { n: number }).n;

beforeEach(async () => {
  t = createTestD1();
  store = createD1Store(t.db);
  user = await store.upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' });
});

describe('calendar feed store', () => {
  it('has no feed until one is created', async () => {
    expect(await store.getCalendarFeed(user.id)).toBeNull();
    expect(await store.getCalendarFeedByHash('nope')).toBeNull();
    expect(await store.deleteCalendarFeed(user.id)).toBe(false);
  });

  it('creates a feed found by user id (metadata only) and by token hash (with the cache)', async () => {
    await store.replaceCalendarFeed(user.id, { tokenHash: 'hash-1', createdAt: 1000 });
    expect(await store.getCalendarFeed(user.id)).toEqual({
      userId: user.id,
      createdAt: 1000,
      lastFetchAt: null,
      cacheAt: null,
    });
    expect(await store.getCalendarFeedByHash('hash-1')).toEqual({
      userId: user.id,
      createdAt: 1000,
      lastFetchAt: null,
      cacheAt: null,
      cacheIcs: null,
    });
  });

  it('records fetches, with and without a new cached feed', async () => {
    await store.replaceCalendarFeed(user.id, { tokenHash: 'hash-1', createdAt: 1000 });
    await store.recordCalendarFetch(user.id, { at: 2000, ics: 'BEGIN:VCALENDAR' });
    expect(await store.getCalendarFeedByHash('hash-1')).toMatchObject({
      lastFetchAt: 2000,
      cacheAt: 2000,
      cacheIcs: 'BEGIN:VCALENDAR',
    });

    await store.recordCalendarFetch(user.id, { at: 3000 });
    expect(await store.getCalendarFeedByHash('hash-1')).toMatchObject({
      lastFetchAt: 3000,
      cacheAt: 2000,
      cacheIcs: 'BEGIN:VCALENDAR',
    });
    expect(await store.getCalendarFeed(user.id)).not.toHaveProperty('cacheIcs');
  });

  it('rotating replaces the token and resets the fetch time and the cache', async () => {
    await store.replaceCalendarFeed(user.id, { tokenHash: 'hash-1', createdAt: 1000 });
    await store.recordCalendarFetch(user.id, { at: 2000, ics: 'old feed' });

    await store.replaceCalendarFeed(user.id, { tokenHash: 'hash-2', createdAt: 5000 });
    expect(await store.getCalendarFeedByHash('hash-1')).toBeNull();
    expect(await store.getCalendarFeedByHash('hash-2')).toEqual({
      userId: user.id,
      createdAt: 5000,
      lastFetchAt: null,
      cacheAt: null,
      cacheIcs: null,
    });
    expect(feedRows()).toBe(1);
  });

  it('revoking deletes the feed', async () => {
    await store.replaceCalendarFeed(user.id, { tokenHash: 'hash-1', createdAt: 1000 });
    expect(await store.deleteCalendarFeed(user.id)).toBe(true);
    expect(await store.getCalendarFeedByHash('hash-1')).toBeNull();
    expect(await store.getCalendarFeed(user.id)).toBeNull();
  });

  it('keeps token hashes unique across users', async () => {
    const other = await store.upsertUser({ moodleUserId: 1002, fullname: 'Hanako Sato', lang: 'en' });
    await store.replaceCalendarFeed(user.id, { tokenHash: 'same', createdAt: 1000 });
    await expect(store.replaceCalendarFeed(other.id, { tokenHash: 'same', createdAt: 1000 })).rejects.toThrow();
  });

  it('is removed with the user', async () => {
    await store.replaceCalendarFeed(user.id, { tokenHash: 'hash-1', createdAt: 1000 });
    await store.deleteUser(user.id);
    expect(feedRows()).toBe(0);
  });
});
