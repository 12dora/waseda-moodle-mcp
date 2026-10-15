/** Helpers shared by the console API route modules. */

import type { Context } from 'hono';
import type { UserRow } from '../../core/context';
import { InvalidInput } from '../../core/errors';
import type { Scope } from '../../core/types';
import { type AppEnv, deferOn, loadSession, readSessionCookie, requireSession } from '../auth';
import { buildServiceContext, consoleProps, tryExecutionContext } from '../context';
import { type Env, isScope } from '../env';
import { createD1Store, type D1Store } from '../store-d1';

export const EXTENSION_REFRESH_PATH = '/api/extension/refresh';
export const HANDOFF_PATH = '/api/connect/handoff';

/** Cookie-less cross-origin endpoints: protected by their payload and a rate limit instead of the CSRF header. */
export const CSRF_EXEMPT_PATHS: ReadonlySet<string> = new Set([EXTENSION_REFRESH_PATH, HANDOFF_PATH]);

/** Moodle course ids are signed 32-bit; the same bound as GET /api/due. */
export const MAX_COURSE_ID = 2_147_483_647;

const MAX_BODY_BYTES = 64 * 1024;

export const storeOf = (env: Env): D1Store => createD1Store(env.DB);

/** Route middleware: requires a console session and exposes `user` / `sessionHash`. */
export const session = requireSession(storeOf);

const TOO_LARGE = 'Request body is too large.';

/** Reads at most `max` bytes: rejects on a declared oversize and stops reading as soon as the limit is crossed. */
async function readLimitedText(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) throw new InvalidInput(TOO_LARGE);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new InvalidInput(TOO_LARGE);
    }
    text += decoder.decode(value, { stream: true });
  }
}

export async function readJson(c: { req: { raw: Request } }): Promise<Record<string, unknown>> {
  const text = await readLimitedText(c.req.raw, MAX_BODY_BYTES);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidInput('Request body must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidInput('Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/** The signed-in user of this request, if any (no error when signed out). */
export async function optionalSessionUser(c: Context<AppEnv>): Promise<UserRow | null> {
  const cookie = readSessionCookie(c.req.raw);
  if (!cookie) return null;
  return (await loadSession(storeOf(c.env), cookie, (p) => deferOn(c, p)))?.user ?? null;
}

export function reqString(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new InvalidInput(`${name} is required.`);
  if (v.length > max) throw new InvalidInput(`${name} is too long.`);
  return v;
}

export function optString(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return reqString(v, name, max);
}

export function intParam(v: string | undefined, name: string, range: { min: number; max: number }): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (!/^\d+$/.test(v)) throw new InvalidInput(`${name} must be a whole number.`);
  const n = Number(v);
  if (n < range.min || n > range.max) throw new InvalidInput(`${name} must be between ${range.min} and ${range.max}.`);
  return n;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], message: string): T {
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) throw new InvalidInput(message);
  return hit;
}

/** read is implied by write; order is stable; empty stays empty. */
export function normalizeScopes(scopes: readonly Scope[]): Scope[] {
  if (scopes.length === 0) return [];
  return scopes.includes('moodle:write') ? ['moodle:read', 'moodle:write'] : ['moodle:read'];
}

export function scopesFrom(v: unknown, fallback: Scope[]): Scope[] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || !v.every(isScope)) throw new InvalidInput('scopes must be moodle:read and/or moodle:write.');
  return normalizeScopes(v);
}

/** Single-line, control-character-free label (client names, key names). */
export function cleanLabel(s: string, max = 80): string {
  const printable = Array.from(s, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('');
  return printable.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Service context for console-originated calls (full authority of the signed-in user). */
export function consoleContext(c: Context<AppEnv>, user: UserRow) {
  return buildServiceContext(c.env, tryExecutionContext(c), consoleProps(user), { user });
}

/** Best-effort audit entry written after the response. */
export function auditConsole(c: Context<AppEnv>, user: UserRow, action: string, detail: Record<string, unknown>): void {
  deferOn(c, storeOf(c.env).audit({ userId: user.id, at: Date.now(), actor: 'console', action, detail }));
}
