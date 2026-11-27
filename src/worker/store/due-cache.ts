/** The console's copy of each due-list answer (GET /api/due, migration 0015): one row per user and query. */

import type { DueList } from '../../core/types';
import { parseJson, toJson } from './rows';

interface DueCacheEntry {
  list: DueList;
  /** When the answer was computed (epoch ms). */
  createdAt: number;
}

export interface DueCacheMethods {
  /** null = no copy (or one that no longer parses). */
  getDueCache(userId: number, query: string): Promise<DueCacheEntry | null>;
  /** Replaces the copy of that query. */
  putDueCache(userId: number, query: string, entry: DueCacheEntry): Promise<void>;
}

export function dueCacheMethods(db: D1Database): DueCacheMethods {
  return {
    async getDueCache(userId, query) {
      const r = await db
        .prepare('SELECT body, created_at FROM due_cache WHERE user_id = ? AND query = ?')
        .bind(userId, query)
        .first<{ body: string; created_at: number }>();
      const list = parseJson<DueList | null>(r?.body, null);
      return r && list ? { list, createdAt: r.created_at } : null;
    },

    async putDueCache(userId, query, entry) {
      await db
        .prepare(
          `INSERT INTO due_cache (user_id, query, body, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, query) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`,
        )
        .bind(userId, query, toJson(entry.list), entry.createdAt)
        .run();
    },
  };
}
