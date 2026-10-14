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

export function sessionCookieHeader(value: string): string {
  return `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return v || null;
    }
  }
  return null;
}

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

const kvLocal = new Map<string, number>();
const KV_FREE_HITS = 2;

export interface KvRateLimit {
  kv: KVNamespace;
  id: string;
  limit: number;
  windowSec?: number;
  now?: number;
}

/**
 * Hourly KV-backed counter that keeps KV writes tiny (Free: 1000 writes/day): the first two hits per window in an
 * isolate touch no KV at all; from the third on the shared counter is read, compared and written back.
 * Counting is best effort (isolates race), the point is to stop floods, not to meter exactly.
 */
export async function kvRateLimit(opts: KvRateLimit): Promise<void> {
  const windowSec = opts.windowSec ?? 3600;
  const bucket = Math.floor((opts.now ?? Date.now()) / (windowSec * 1000));
  const key = `rl:${opts.id}:${bucket}`;
  if (kvLocal.size > 2000) kvLocal.clear();
  const local = (kvLocal.get(key) ?? 0) + 1;
  kvLocal.set(key, local);
  if (local <= KV_FREE_HITS) return;
  const stored = Number(await opts.kv.get(key)) || 0;
  const total = Math.max(stored, local - 1) + 1;
  if (total > opts.limit) throw new RateLimited('Too many refresh attempts. Try again later.');
  await opts.kv.put(key, String(total), { expirationTtl: windowSec + 120 });
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
