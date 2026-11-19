import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Scope } from '../core/types';

export const VERSION = '0.1.0';

/** Worker bindings, secrets and vars (see wrangler.jsonc). */
export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  /** Secret: 32 random bytes, base64. Encrypts Moodle tokens and signs file tickets. */
  MASTER_KEY: string;
  PUBLIC_URL: string;
  /** 'open' | 'allowlist' (anything else is treated as 'allowlist'). */
  REGISTRATION: string;
  /** Comma separated Moodle user ids allowed to register when REGISTRATION is 'allowlist'. */
  ALLOWED_MOODLE_USERIDS: string;
  /** Comma separated Moodle user ids of the operators who may see the usage statistics. */
  ADMIN_MOODLE_USERIDS?: string;
  EXTENSION_URL?: string;
  /** 'off' disables the public-syllabus term lookup (default on). */
  SYLLABUS_LOOKUP?: string;
  /** Cloudflare Web Analytics site token (32 hex chars). When valid, the landing pages carry the cookieless beacon. */
  CF_BEACON_TOKEN?: string;
  /** Google OAuth client id of the Waseda mail connection. Mail is off unless both id and secret are set. */
  GOOGLE_CLIENT_ID?: string;
  /** Secret: Google OAuth client secret. */
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Mail slots (Moodle users who may ever connect a mailbox); empty = 80, 'off' = no limit (a verified Google app),
   * 0 = no new connections (users who already hold a slot may still reconnect).
   */
  MAIL_SLOTS?: string;
  /** Days without a mail tool call after which a mail connection is revoked; empty or 0 = 90, 'off' = never. */
  MAIL_IDLE_DAYS?: string;
  /** Injected by workers-oauth-provider on every request that reaches our handlers. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Props the OAuth provider hands to the MCP handler (`ctx.props`), for OAuth grants and API keys alike. */
export interface McpProps {
  userId: number;
  scopes: Scope[];
  /** Display label: OAuth client name or "API key: <name>". */
  source: string;
}

export function isScope(v: unknown): v is Scope {
  return v === 'moodle:read' || v === 'moodle:write';
}

/** PUBLIC_URL without trailing slashes ('' when unset). */
export function publicUrlOf(env: Pick<Env, 'PUBLIC_URL'>): string {
  return (env.PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
}

export function registrationMode(env: Pick<Env, 'REGISTRATION'>): 'open' | 'allowlist' {
  return (env.REGISTRATION ?? '').trim().toLowerCase() === 'open' ? 'open' : 'allowlist';
}

export function allowedMoodleUserIds(env: Pick<Env, 'ALLOWED_MOODLE_USERIDS'>): Set<number> {
  const out = new Set<number>();
  for (const part of (env.ALLOWED_MOODLE_USERIDS ?? '').split(/[\s,;]+/)) {
    if (/^\d+$/.test(part)) out.add(Number(part));
  }
  return out;
}

/** Operator Moodle user ids (usage statistics); parsed like the allowlist. */
export function adminMoodleUserIds(env: Pick<Env, 'ADMIN_MOODLE_USERIDS'>): Set<number> {
  const out = new Set<number>();
  for (const part of (env.ADMIN_MOODLE_USERIDS ?? '').split(/[\s,;]+/)) {
    if (/^\d+$/.test(part)) out.add(Number(part));
  }
  return out;
}

/** Google OAuth client of the mail connection; null = mail is not configured. */
export function googleClientOf(
  env: Pick<Env, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>,
): { clientId: string; clientSecret: string } | null {
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Integer setting of at least `min` with a default; 'off' = null (no limit). Anything unparsable or below `min` falls
 * back to the default.
 */
function limitSetting(raw: string | undefined, fallback: number, min: number): number | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'off') return null;
  return /^\d+$/.test(v) && Number(v) >= min ? Number(v) : fallback;
}

const DEFAULT_MAIL_SLOTS = 80;
const DEFAULT_MAIL_IDLE_DAYS = 90;

/** Mail slot limit; null = unlimited, 0 = no new connections. */
export const mailSlotsOf = (env: Pick<Env, 'MAIL_SLOTS'>): number | null =>
  limitSetting(env.MAIL_SLOTS, DEFAULT_MAIL_SLOTS, 0);

/** Idle days before a mail connection is revoked; null = never. */
export const mailIdleDaysOf = (env: Pick<Env, 'MAIL_IDLE_DAYS'>): number | null =>
  limitSetting(env.MAIL_IDLE_DAYS, DEFAULT_MAIL_IDLE_DAYS, 1);
