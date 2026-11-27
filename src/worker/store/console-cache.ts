/**
 * The console's copy of each Moodle-backed answer (GET /api/due, /api/courses, …; migration 0016): one row per user and
 * cache key (`<route>?<normalised query>`).
 */

import { parseJson, toJson } from './rows';

interface ConsoleCacheEntry<T extends object = object> {
  body: T;
  /** When the answer was computed (epoch ms). */
  createdAt: number;
}

export interface ConsoleCacheMethods {
  /** null = no copy (or one that no longer parses as a JSON object). */
  getConsoleCache<T extends object>(userId: number, key: string): Promise<ConsoleCacheEntry<T> | null>;
  /** Replaces the copy of that key. */
  putConsoleCache(userId: number, key: string, entry: ConsoleCacheEntry): Promise<void>;
  /** Deletes every copy of the user (a write changed what the console reads). */
  clearConsoleCache(userId: number): Promise<void>;
}

export function consoleCacheMethods(db: D1Database): ConsoleCacheMethods {
  return {
    async getConsoleCache<T extends object>(userId: number, key: string) {
      const r = await db
        .prepare('SELECT body, created_at FROM console_cache WHERE user_id = ? AND cache_key = ?')
        .bind(userId, key)
        .first<{ body: string; created_at: number }>();
      const body = parseJson<unknown>(r?.body, null);
      if (!r || !body || typeof body !== 'object' || Array.isArray(body)) return null;
      return { body: body as T, createdAt: r.created_at };
    },

    async putConsoleCache(userId, key, entry) {
      await db
        .prepare(
          `INSERT INTO console_cache (user_id, cache_key, body, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, cache_key) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`,
        )
        .bind(userId, key, toJson(entry.body), entry.createdAt)
        .run();
    },

    async clearConsoleCache(userId) {
      await db.prepare('DELETE FROM console_cache WHERE user_id = ?').bind(userId).run();
    },
  };
}
