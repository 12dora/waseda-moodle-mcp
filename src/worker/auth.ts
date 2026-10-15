/**
 * Console sessions, CSRF, API keys and abuse limits for the Worker.
 * Everything here is cheap on purpose (Workers Free: 10 ms CPU): one hash + one D1 lookup per authenticated request.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { SessionRow, Store, UserRow } from '../core/context';
import { randomId, sha256Hex } from '../core/crypto';
import { Forbidden, RateLimited, WmmError } from '../core/errors';
import { allowedMoodleUserIds, type Env, type McpProps, publicUrlOf, registrationMode } from './env';
import type { D1Store } from './store-d1';

export const SESSION_COOKIE = '__Host-wmm_s';
export const SESSION_TTL_MS = 30 * 86_400_000;
/** Sliding expiry: the row and cookie are refreshed at most this often. */
export const SESSION_TOUCH_MS = 6 * 3_600_000;
const API_KEY_TOUCH_MS = 3_600_000;

/** Hono environment of the console API. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    user: UserRow;
    sessionHash: string;
  };
}

class Unauthorized extends WmmError {
  constructor(message = 'Sign in to continue.') {
    super(message, 'unauthorized');
  }
}

// ------------------------------------------------------------------ cookies

/** `__Host-` cookies: Secure, Path=/, no Domain, HttpOnly, SameSite=Lax. */
export function hostCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i >= 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export const sessionCookieHeader = (value: string): string => hostCookie(SESSION_COOKIE, value, SESSION_TTL_MS / 1000);
export const clearSessionCookieHeader = (): string => hostCookie(SESSION_COOKIE, '', 0);
export const readSessionCookie = (request: Request): string | null => readCookie(request, SESSION_COOKIE);

// ------------------------------------------------------------------ sessions

/** Creates the session row; the raw cookie value is returned once and only its hash is stored. */
export async function startSession(
  store: Store,
  userId: number,
  userAgent: string | null,
  now = Date.now(),
): Promise<{ cookieValue: string; setCookie: string }> {
  const cookieValue = randomId('s', 32);
  const row: SessionRow = {
    idHash: await sha256Hex(cookieValue),
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastSeenAt: now,
    userAgent: userAgent ? userAgent.slice(0, 200) : null,
  };
  await store.createSession(row);
  return { cookieValue, setCookie: sessionCookieHeader(cookieValue) };
}

export interface LoadedSession {
  user: UserRow;
  sessionHash: string;
  /** True when the sliding expiry was refreshed (caller re-sends the cookie). */
  touched: boolean;
}

export async function loadSession(
  store: D1Store,
  cookieValue: string,
  defer: (p: Promise<unknown>) => void,
  now = Date.now(),
): Promise<LoadedSession | null> {
  const sessionHash = await sha256Hex(cookieValue);
  const found = await store.getSessionWithUser(sessionHash);
  if (!found) return null;
  if (found.session.expiresAt <= now) {
    defer(store.deleteSession(sessionHash).catch(() => undefined));
    return null;
  }
  let touched = false;
  if (now - found.session.lastSeenAt > SESSION_TOUCH_MS) {
    touched = true;
    defer(
      Promise.all([
        store.touchSession(sessionHash, now, now + SESSION_TTL_MS),
        store.touchUser(found.user.id, now),
      ]).catch(() => undefined),
    );
  }
  return { user: found.user, sessionHash, touched };
}

/** Run `p` after the response when an execution context exists, else just detach it (tests). */
export function deferOn(c: Context<AppEnv>, p: Promise<unknown>): void {
  const guarded = p.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // no ExecutionContext (unit tests): the promise runs detached
  }
}

/** Requires a valid console session; exposes `user` and `sessionHash` on the context. */
export function requireSession(getStore: (env: Env) => D1Store): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cookie = readSessionCookie(c.req.raw);
    if (!cookie) throw new Unauthorized();
    const loaded = await loadSession(getStore(c.env), cookie, (p) => deferOn(c, p));
    if (!loaded) throw new Unauthorized();
    c.set('user', loaded.user);
    c.set('sessionHash', loaded.sessionHash);
    await next();
    if (loaded.touched && !c.res.headers.has('Set-Cookie')) {
      c.res.headers.append('Set-Cookie', sessionCookieHeader(cookie));
    }
  };
}

// ------------------------------------------------------------------ CSRF

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function expectedOrigin(env: Env, requestUrl: string): string {
  const base = publicUrlOf(env) || new URL(requestUrl).origin;
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

/** State-changing console requests need `X-WMM: 1` and, when the browser sends Origin, our own origin. */
export function csrfGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      if (c.req.header('X-WMM') !== '1') throw new Forbidden('Missing X-WMM header.');
      const origin = c.req.header('Origin');
      if (origin !== undefined && origin !== expectedOrigin(c.env, c.req.url)) {
        throw new Forbidden('Cross-origin request blocked.');
      }
    }
    await next();
  };
}

// ------------------------------------------------------------------ API keys

/** `wmm_` + base62; anything else is not ours (keeps the OAuth library's `a:b:c` token shape out of play). */
export const API_KEY_PATTERN = /^wmm_[0-9A-Za-z]{20,80}$/;

export async function resolveApiKey(
  store: Store,
  token: string,
  defer?: (p: Promise<unknown>) => void,
  now = Date.now(),
): Promise<McpProps | null> {
  if (!API_KEY_PATTERN.test(token)) return null;
  const row = await store.getApiKeyByHash(await sha256Hex(token));
  if (!row || row.revokedAt !== null) return null;
  if (row.lastUsedAt === null || now - row.lastUsedAt > API_KEY_TOUCH_MS) {
    const p = store.touchApiKey(row.id, now).catch(() => undefined);
    if (defer) defer(p);
    else await p;
  }
  const scopes = row.scopes.includes('moodle:read')
    ? row.scopes
    : (['moodle:read', ...row.scopes] as McpProps['scopes']);
  return { userId: row.userId, scopes, source: `API key: ${row.name}` };
}

// ------------------------------------------------------------------ registration policy

/** `open`: anyone with a valid Waseda Moodle token may register; `allowlist`: only ALLOWED_MOODLE_USERIDS. */
export function registrationPolicy(env: Env): (moodleUserId: number) => boolean {
  if (registrationMode(env) === 'open') return () => true;
  const allowed = allowedMoodleUserIds(env);
  return (id) => allowed.has(id);
}

// ------------------------------------------------------------------ rate limits

type Counters = Map<string, { n: number; resetAt: number }>;

const COUNTER_CAP = 2000;
/** MCP per-user limiter state. Separate from `preCounters` so IP churn can never reset user counters. */
const memoryCounters: Counters = new Map();
/** `rateLimit` pre-check state: requests D1 allowed (or failed open on), per rule key. */
const preCounters: Counters = new Map();

/** Fixed-window increment in a bounded map; returns the new count. */
function hitCounter(map: Counters, key: string, windowMs: number, now: number): number {
  if (map.size > COUNTER_CAP) {
    for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
    if (map.size > COUNTER_CAP) map.clear();
  }
  const cur = map.get(key);
  if (!cur || cur.resetAt <= now) {
    map.set(key, { n: 1, resetAt: now + windowMs });
    return 1;
  }
  cur.n += 1;
  return cur.n;
}

/** Best-effort per-isolate limiter (no KV I/O) for cheap abuse damping. Throws RateLimited. */
export function memoryRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): void {
  if (hitCounter(memoryCounters, key, windowMs, now) > limit) throw new RateLimited();
}

export interface RateLimitRule {
  /** Counter key, e.g. `ext:ip:203.0.113.7`. */
  key: string;
  limit: number;
  windowMs: number;
}

/**
 * Fixed-window counter in D1 (KV is reserved for the OAuth library: Free KV allows 1000 writes/day).
 * Throws RateLimited above the limit. Storage failures fail OPEN: an outage must not lock everybody out.
 */
export async function rateLimit(store: D1Store, rule: RateLimitRule, now = Date.now()): Promise<void> {
  // Keys this isolate already saw over the limit are refused without another D1 write (D1 Free: 100k writes/day).
  const blockedUntil = blockedKeys.get(rule.key);
  if (blockedUntil !== undefined && blockedUntil > now) throw new RateLimited();
  // The pre-check only counts requests D1 allowed (any window of one length spans ≤2 D1 windows, so ≤2×limit), so it
  // trips only while D1 is down and failing open, and never blocks longer than D1 would.
  const pre = preCounters.get(rule.key);
  if (pre && pre.resetAt > now && pre.n >= rule.limit * 2) throw new RateLimited();
  let hits = 0;
  try {
    hits = await store.hitRateLimit(rule.key, rule.windowMs, now);
  } catch {
    // fail open: counted below as allowed
  }
  if (hits > rule.limit) {
    if (blockedKeys.size > COUNTER_CAP) blockedKeys.clear();
    // D1 windows start at the first hit (unknown here), so only remember the block briefly.
    blockedKeys.set(rule.key, now + Math.min(rule.windowMs / 10, 60_000));
    throw new RateLimited();
  }
  hitCounter(preCounters, rule.key, rule.windowMs, now);
}

const blockedKeys = new Map<string, number>();

/** Tests: forget this isolate's counters and blocked keys. */
export function resetRateLimitMemory(): void {
  blockedKeys.clear();
  memoryCounters.clear();
  preCounters.clear();
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
