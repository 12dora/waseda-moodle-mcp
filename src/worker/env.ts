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
  EXTENSION_URL?: string;
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
