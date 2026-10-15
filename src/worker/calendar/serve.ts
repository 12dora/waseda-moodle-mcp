/**
 * Serves one feed: the 30-minute D1 cache (stale-while-revalidate), a rebuild through the user's stored Moodle
 * credential, and what to answer when the rebuild fails. A built or cached feed is always served: bookkeeping writes
 * are best effort.
 */

import type { CalendarFeedRow, Store } from '../../core/context';
import { NeedsReconnect } from '../../core/errors';
import { MAX_FETCHES_PER_CALL } from '../../core/services/syllabus';
import { buildServiceContext, type WaitUntil } from '../context';
import { type Env, publicUrlOf } from '../env';
import { buildFeed, reconnectFeed } from './feed';

export const FEED_CACHE_MS = 30 * 60_000;
/** A copy older than this is never served in place of a failed rebuild, nor ahead of one (it would mislead). */
export const MAX_STALE_MS = 24 * 3_600_000;
/** `last_fetch_at` is only a "last used" hint for the console; cache hits write it at most this often. */
const FETCH_TOUCH_MS = 3_600_000;
/** Free plan: 50 subrequests per invocation. */
const SUBREQUEST_LIMIT = 50;
/** Left over for stray calls (e.g. a credential refresh), outside the two budgets below. */
const SUBREQUEST_SPARE = 2;
/**
 * Moodle calls one feed build may spend. The timetable's public syllabus fetches (MAX_FETCHES_PER_CALL = 12) come out
 * of the same 50 subrequests: 36 + 12 ≤ 50, with 2 to spare (D1 queries are not subrequests).
 */
const FEED_CALL_BUDGET = SUBREQUEST_LIMIT - MAX_FETCHES_PER_CALL - SUBREQUEST_SPARE;
const FEED_SOURCE = 'Calendar feed';

/**
 * fresh: the cached copy is served as it is. stale: it is served now and rebuilt after the response (needs an
 * execution context; a rebuild killed with the response costs nothing). build: nothing usable is cached, so the
 * request builds the feed itself.
 */
type FeedPlan = { mode: 'build' } | { mode: 'fresh' | 'stale'; ics: string };

export function planFeed(feed: CalendarFeedRow, now: number, canDefer: boolean): FeedPlan {
  if (feed.cacheIcs === null || feed.cacheAt === null) return { mode: 'build' };
  const age = now - feed.cacheAt;
  if (age < FEED_CACHE_MS) return { mode: 'fresh', ics: feed.cacheIcs };
  return canDefer && age < MAX_STALE_MS ? { mode: 'stale', ics: feed.cacheIcs } : { mode: 'build' };
}

interface FeedDeps {
  store: Store;
  execCtx: WaitUntil | undefined;
}

interface FeedJob {
  feed: CalendarFeedRow;
  plan: FeedPlan;
  now: number;
}

/** A bookkeeping write must never cost the response: errors are dropped, and it runs after it when it can. */
function settle(deps: FeedDeps, write: () => Promise<void>): Promise<void> {
  const guarded = Promise.resolve()
    .then(write)
    .catch(() => undefined);
  if (!deps.execCtx) return guarded;
  deps.execCtx.waitUntil(guarded);
  return Promise.resolve();
}

/** The last-fetch stamp, written only when the stored one is missing or older than an hour. */
function touch(deps: FeedDeps, feed: CalendarFeedRow, now: number): Promise<void> {
  if (feed.lastFetchAt !== null && now - feed.lastFetchAt <= FETCH_TOUCH_MS) return Promise.resolve();
  return settle(deps, () => deps.store.recordCalendarFetch(feed.userId, { at: now }));
}

async function rebuild(env: Env, deps: FeedDeps, job: FeedJob): Promise<string> {
  const ctx = await buildServiceContext(
    env,
    deps.execCtx,
    { userId: job.feed.userId, scopes: ['moodle:read'], source: FEED_SOURCE },
    { maxCalls: FEED_CALL_BUDGET, touchUser: false },
  );
  return buildFeed(ctx, job.now);
}

const reconnectNotice = (env: Env, now: number): string => reconnectFeed({ publicUrl: publicUrlOf(env), now });

/** After the response: a better copy replaces the stale one; a lost credential is cached as the reconnect notice. */
async function refreshAfterResponse(env: Env, deps: FeedDeps, job: FeedJob): Promise<void> {
  const { feed, now } = job;
  try {
    const ics = await rebuild(env, deps, job);
    await deps.store.recordCalendarFetch(feed.userId, { at: now, ics });
  } catch (e) {
    if (e instanceof NeedsReconnect) {
      await deps.store.recordCalendarFetch(feed.userId, { at: now, ics: reconnectNotice(env, now) });
      return;
    }
    console.error('calendar feed refresh failed:', e instanceof Error ? e.name : 'unknown');
  }
}

/**
 * A rebuild failed. A lost credential gets the reconnect notice, never the stale copy (it would hide the problem).
 * Other errors (Moodle down, budget, unknown) serve a copy younger than MAX_STALE_MS so the calendar keeps its events;
 * with none, the error propagates (the route answers 503).
 */
async function failedBuild(env: Env, deps: FeedDeps, job: FeedJob, e: unknown): Promise<string> {
  if (e instanceof NeedsReconnect) return reconnectNotice(env, job.now);
  console.error('calendar feed rebuild failed:', e instanceof Error ? e.name : 'unknown');
  const { feed, now } = job;
  if (feed.cacheIcs === null || feed.cacheAt === null || now - feed.cacheAt >= MAX_STALE_MS) throw e;
  await touch(deps, feed, now);
  return feed.cacheIcs;
}

async function buildNow(env: Env, deps: FeedDeps, job: FeedJob): Promise<string> {
  let ics: string;
  try {
    ics = await rebuild(env, deps, job);
  } catch (e) {
    return failedBuild(env, deps, job, e);
  }
  await settle(deps, () => deps.store.recordCalendarFetch(job.feed.userId, { at: job.now, ics }));
  return ics;
}

/** The ICS text for a feed row, following the `plan` (see planFeed). */
export async function loadFeed(env: Env, deps: FeedDeps, job: FeedJob): Promise<string> {
  const { plan, feed, now } = job;
  if (plan.mode === 'build') return buildNow(env, deps, job);
  await touch(deps, feed, now);
  if (plan.mode === 'stale') deps.execCtx?.waitUntil(refreshAfterResponse(env, deps, job).catch(() => undefined));
  return plan.ics;
}
