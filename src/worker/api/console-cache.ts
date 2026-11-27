/**
 * Stale-while-revalidate for the console's Moodle-backed reads (GET /api/due, /api/courses, /api/courses/overview,
 * /api/timetable, /api/updates, /api/syllabus; migration 0016). One Moodle web session serialises its requests, so the
 * console's cards fetched in parallel used to add up (26 s page loads): each answer now comes from the stored copy at
 * once and the console asks again with `refresh=1` in the background.
 */

import type { Context } from 'hono';
import { MoodleBusy } from '../../core/errors';
import { isoJst } from '../../core/time';
import { type AppEnv, deferOn } from '../auth';
import { sessionBusyUntil } from '../context';
import type { D1Store } from '../store-d1';
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

interface Lookup {
  c: Context<AppEnv>;
  store: D1Store;
  userId: number;
  key: string;
}

/**
 * The Moodle web session is busy (MoodleBusy): the stored copy as `{ ...body, cachedAt, stale: true, busy: true }`
 * (the console keeps showing it), or, without one, the error itself (moodle_busy, 503 with Retry-After).
 */
async function busyAnswer<T extends object>(l: Lookup, busy: MoodleBusy): Promise<Response> {
  const cached = await l.store.getConsoleCache<T>(l.userId, l.key);
  if (!cached) throw busy;
  return l.c.json({ ...cached.body, cachedAt: isoJst(cached.createdAt), stale: true, busy: true });
}

/**
 * The stored copy of `key` answers at once as `{ ...body, cachedAt, stale: true }`. Without one, or with `refresh=1`,
 * `compute` runs; its answer is stored after the response (a failed compute, or one `keep` rejects, stores nothing and
 * keeps the old copy) and returned with `stale: false`. While the user's web session is busy (one of its requests ran
 * out of time) `compute` does not run, so nothing queues up behind it at Moodle: see busyAnswer. Bodies are JSON
 * objects (every cached route answers one).
 */
export async function cachedRoute<T extends object>(
  c: Context<AppEnv>,
  key: string,
  compute: () => Promise<T>,
  opts: CacheOptions<T> = {},
): Promise<Response> {
  const lookup: Lookup = { c, store: storeOf(c.env), userId: c.get('user').id, key };
  const { store, userId } = lookup;
  const cached = c.req.query('refresh') === '1' ? null : await store.getConsoleCache<T>(userId, key);
  if (cached) return c.json({ ...cached.body, cachedAt: isoJst(cached.createdAt), stale: true });

  const busyUntil = await sessionBusyUntil(store, userId);
  if (busyUntil !== null) return busyAnswer<T>(lookup, new MoodleBusy(busyUntil));
  let body: T;
  try {
    body = await compute();
  } catch (e) {
    // a request of this compute ran out of time and the session turned busy
    if (e instanceof MoodleBusy) return busyAnswer<T>(lookup, e);
    throw e;
  }
  const createdAt = Date.now();
  if (opts.keep?.(body) !== false) deferOn(c, store.putConsoleCache(userId, key, { body, createdAt }));
  return c.json({ ...body, cachedAt: isoJst(createdAt), stale: false });
}
