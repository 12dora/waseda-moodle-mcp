/**
 * Calendar feed routes (§17.2): the session API that creates / rotates / revokes the secret URL, and the public
 * `GET /cal/<token>.ics` feed itself. The token is 32 random bytes (base64url, shown once); only its SHA-256 is stored.
 */

import { Hono } from 'hono';
import { b64urlEncode, sha256Hex } from '../../core/crypto';
import { NotFound, RateLimited, WmmError } from '../../core/errors';
import { isoJst } from '../../core/time';
import { auditConsole, session, storeOf } from '../api/shared';
import { type AppEnv, clientIp, memoryRateLimit, rateLimit } from '../auth';
import { tryExecutionContext } from '../context';
import { publicUrlOf } from '../env';
import { errorPayload } from '../http-errors';
import type { D1Store } from '../store-d1';
import { loadFeed, planFeed } from './serve';

const TOKEN_BYTES = 32;
const FEED_FILE = /^([A-Za-z0-9_-]{43})\.ics$/; // 43 = base64url length of 32 bytes
const FEED_RATE = { limit: 12, windowMs: 3_600_000 };
/** Unknown-token requests per IP, counted per isolate in memory (no D1 write); damps guessing, not shared IPs. */
const MISS_LIMIT = { limit: 30, windowMs: 600_000 };
const MISS_CAP = 2000;
const RETRY_AFTER_SEC = 1800;

const misses = new Map<string, { n: number; resetAt: number }>();

/** True while `ip` is over the miss limit. Read only: the miss itself is counted by recordMiss, after the lookup. */
function overMissLimit(ip: string, now: number): boolean {
  const cur = misses.get(ip);
  return cur !== undefined && cur.resetAt > now && cur.n >= MISS_LIMIT.limit;
}

function recordMiss(ip: string, now: number): void {
  if (misses.size > MISS_CAP) {
    for (const [k, v] of misses) if (v.resetAt <= now) misses.delete(k);
    if (misses.size > MISS_CAP) misses.clear();
  }
  const cur = misses.get(ip);
  if (cur && cur.resetAt > now) cur.n += 1;
  else misses.set(ip, { n: 1, resetAt: now + MISS_LIMIT.windowMs });
}

/** Tests: forget the per-IP miss counters. */
export function resetCalendarMisses(): void {
  misses.clear();
}

/** A transient failure answer for calendar apps: plain text, retried by the app later. */
function unavailable(e: unknown): Response {
  const message = e instanceof WmmError ? e.message : 'The calendar is temporarily unavailable.';
  return new Response(message, {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': String(RETRY_AFTER_SEC),
      'Cache-Control': 'no-store',
    },
  });
}

function tooManyRequests(windowMs: number): Response {
  const { body } = errorPayload(new RateLimited());
  return Response.json(body, {
    status: 429,
    headers: { 'Retry-After': String(windowMs / 1000), 'Cache-Control': 'no-store' },
  });
}

/**
 * Per-token limit. A request answered from the cache costs no D1 write (in-memory counter only); one that has to
 * build the feed goes through the D1 counter.
 */
async function admit(store: D1Store, userId: number, building: boolean): Promise<void> {
  const rule = { key: `cal:${userId}`, ...FEED_RATE };
  if (building) await rateLimit(store, rule);
  else memoryRateLimit(`cal:hit:${userId}`, rule.limit, rule.windowMs);
}

export function calendarRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/calendar', session, async (c) => {
    const feed = await storeOf(c.env).getCalendarFeed(c.get('user').id);
    return c.json({
      enabled: feed !== null,
      createdAt: feed ? isoJst(feed.createdAt) : null,
      lastFetchAt: feed?.lastFetchAt ? isoJst(feed.lastFetchAt) : null,
    });
  });

  // creates the feed or rotates its token: the previous URL stops working at once
  app.post('/api/calendar', session, async (c) => {
    const user = c.get('user');
    const token = b64urlEncode(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
    await storeOf(c.env).replaceCalendarFeed(user.id, { tokenHash: await sha256Hex(token), createdAt: Date.now() });
    auditConsole(c, user, 'calendar:create', {});
    const base = publicUrlOf(c.env) || new URL(c.req.url).origin;
    return c.json({ url: `${base}/cal/${token}.ics` });
  });

  app.delete('/api/calendar', session, async (c) => {
    const user = c.get('user');
    if (await storeOf(c.env).deleteCalendarFeed(user.id)) auditConsole(c, user, 'calendar:revoke', {});
    return c.json({ ok: true });
  });

  app.get('/cal/:file', async (c) => {
    const ip = clientIp(c.req.raw);
    const now = Date.now();
    // before the D1 lookup: a guessing IP costs nothing once it is over the limit
    if (overMissLimit(ip, now)) return tooManyRequests(MISS_LIMIT.windowMs);
    const store = storeOf(c.env);
    const token = FEED_FILE.exec(c.req.param('file'))?.[1];
    const feed = token ? await store.getCalendarFeedByHash(await sha256Hex(token)) : null;
    if (!feed) {
      recordMiss(ip, now);
      throw new NotFound('Not found.');
    }
    const execCtx = tryExecutionContext(c);
    const plan = planFeed(feed, now, execCtx !== undefined);
    try {
      await admit(store, feed.userId, plan.mode === 'build');
    } catch (e) {
      if (e instanceof RateLimited) return tooManyRequests(FEED_RATE.windowMs);
      throw e;
    }
    try {
      const ics = await loadFeed(c.env, { store, execCtx }, { feed, plan, now });
      return new Response(ics, {
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'inline; filename="waseda-moodle.ics"',
          'Cache-Control': 'private, max-age=900',
          'Referrer-Policy': 'no-referrer',
          'X-Robots-Tag': 'noindex',
        },
      });
    } catch (e) {
      return unavailable(e);
    }
  });

  return app;
}
