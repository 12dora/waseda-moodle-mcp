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

const memoryCounters = new Map<string, { n: number; resetAt: number }>();

/** Best-effort per-isolate limiter (no KV I/O) for cheap abuse damping. Throws RateLimited. */
export function memoryRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): void {
  if (memoryCounters.size > 2000) {
    for (const [k, v] of memoryCounters) if (v.resetAt <= now) memoryCounters.delete(k);
    if (memoryCounters.size > 2000) memoryCounters.clear();
  }
  const cur = memoryCounters.get(key);
  if (!cur || cur.resetAt <= now) {
    memoryCounters.set(key, { n: 1, resetAt: now + windowMs });
    return;
  }
  cur.n += 1;
  if (cur.n > limit) throw new RateLimited();
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
  let hits: number;
  try {
    hits = await store.hitRateLimit(rule.key, rule.windowMs, now);
  } catch {
    return;
  }
  if (hits > rule.limit) throw new RateLimited();
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
