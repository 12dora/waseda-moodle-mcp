/** Secret ICS calendar feeds: one row per user (token hash, last fetch, 30-minute rendered cache). */

import type { CalendarFeedInfo, Store } from '../../core/context';
import { changes } from './rows';

interface FeedRaw {
  user_id: number;
  created_at: number;
  last_fetch_at: number | null;
  cache_ics: string | null;
  cache_at: number | null;
}

type CalendarMethods = Pick<
  Store,
  'getCalendarFeed' | 'getCalendarFeedByHash' | 'replaceCalendarFeed' | 'deleteCalendarFeed' | 'recordCalendarFetch'
>;

const toInfo = (r: Omit<FeedRaw, 'cache_ics'>): CalendarFeedInfo => ({
  userId: r.user_id,
  createdAt: r.created_at,
  lastFetchAt: r.last_fetch_at,
  cacheAt: r.cache_at,
});

export function calendarMethods(db: D1Database): CalendarMethods {
  return {
    /** Metadata only: the cached feed is tens of KB and the status call does not need it. */
    async getCalendarFeed(userId) {
      const r = await db
        .prepare('SELECT user_id, created_at, last_fetch_at, cache_at FROM calendar_feeds WHERE user_id = ?')
        .bind(userId)
        .first<Omit<FeedRaw, 'cache_ics'>>();
      return r ? toInfo(r) : null;
    },

    async getCalendarFeedByHash(tokenHash) {
      const r = await db
        .prepare(
          'SELECT user_id, created_at, last_fetch_at, cache_ics, cache_at FROM calendar_feeds WHERE token_hash = ?',
        )
        .bind(tokenHash)
        .first<FeedRaw>();
      return r ? { ...toInfo(r), cacheIcs: r.cache_ics } : null;
    },

    async replaceCalendarFeed(userId, feed) {
      await db
        .prepare(
          `INSERT INTO calendar_feeds (user_id, token_hash, created_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at,
             last_fetch_at = NULL, cache_ics = NULL, cache_at = NULL`,
        )
        .bind(userId, feed.tokenHash, feed.createdAt)
        .run();
    },

    async deleteCalendarFeed(userId) {
      return (await changes(db.prepare('DELETE FROM calendar_feeds WHERE user_id = ?').bind(userId))) > 0;
    },

    async recordCalendarFetch(userId, fetch) {
      if (fetch.ics === undefined) {
        await db.prepare('UPDATE calendar_feeds SET last_fetch_at = ? WHERE user_id = ?').bind(fetch.at, userId).run();
        return;
      }
      await db
        .prepare('UPDATE calendar_feeds SET last_fetch_at = ?, cache_ics = ?, cache_at = ? WHERE user_id = ?')
        .bind(fetch.at, fetch.ics, fetch.at, userId)
        .run();
    },
  };
}
