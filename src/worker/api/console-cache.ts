/**
 * Stale-while-revalidate for the console's Moodle-backed reads (GET /api/due, /api/courses, /api/courses/overview,
 * /api/timetable, /api/updates, /api/syllabus; migration 0016). One Moodle web session serialises its requests, so the
 * console's cards fetched in parallel used to add up (26 s page loads): each answer now comes from the stored copy at
 * once and the console asks again with `refresh=1` in the background.
 */

import type { Context } from 'hono';
import { isoJst } from '../../core/time';
import { type AppEnv, deferOn } from '../auth';
import { storeOf } from './shared';

/**
 * The cache key of a request: `<route>?<name>=<value>&…` in the order given, absent values empty, so equal requests
 * share one copy whatever their spelling. Call it with validated, normalised values only.
 */
export function cacheKey(route: string, params: Record<string, string | number | undefined> = {}): string {
  const query = Object.entries(params)
    .map(([name, value]) => `${name}=${value ?? ''}`)
    .join('&');
  return `${route}?${query}`;
}

interface CacheOptions<T> {
  /** false = a degraded answer (a part of it failed): answered, but not stored over the last good copy. */
  keep?: (body: T) => boolean;
}

/**
 * The stored copy of `key` answers at once as `{ ...body, cachedAt, stale: true }`. Without one, or with `refresh=1`,
 * `compute` runs; its answer is stored after the response (a failed compute, or one `keep` rejects, stores nothing and
 * keeps the old copy) and returned with `stale: false`. Bodies are JSON objects (every cached route answers one).
 */
export async function cachedRoute<T extends object>(
  c: Context<AppEnv>,
  key: string,
  compute: () => Promise<T>,
  opts: CacheOptions<T> = {},
): Promise<Response> {
  const user = c.get('user');
  const store = storeOf(c.env);
  const cached = c.req.query('refresh') === '1' ? null : await store.getConsoleCache<T>(user.id, key);
  if (cached) return c.json({ ...cached.body, cachedAt: isoJst(cached.createdAt), stale: true });

  const body = await compute();
  const createdAt = Date.now();
  if (opts.keep?.(body) !== false) deferOn(c, store.putConsoleCache(user.id, key, { body, createdAt }));
  return c.json({ ...body, cachedAt: isoJst(createdAt), stale: false });
}
