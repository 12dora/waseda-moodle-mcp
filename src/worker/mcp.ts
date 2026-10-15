/**
 * `/mcp` API handler. workers-oauth-provider has already authenticated the caller (OAuth token or `wmm_` API key via
 * resolveExternalToken) and put `{userId, scopes, source}` into `ctx.props`.
 */

import { createMcpHandler } from '@modelcontextprotocol/server';
import { NotFound, WmmError } from '../core/errors';
import { buildMcpServer } from '../core/mcp/server';
import { memoryRateLimit } from './auth';
import { buildServiceContext } from './context';
import { type Env, isScope, type McpProps, publicUrlOf } from './env';

function readProps(raw: unknown): McpProps | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.userId !== 'number' || !Number.isInteger(p.userId) || p.userId <= 0) return null;
  if (!Array.isArray(p.scopes)) return null;
  const scopes = p.scopes.filter(isScope);
  return { userId: p.userId, scopes, source: typeof p.source === 'string' && p.source ? p.source : 'MCP client' };
}

const MCP_RATE_LIMIT = 120;
const MCP_RATE_WINDOW_MS = 60_000;

/** OAuth token failure with the RFC 6750 / 9728 challenge so clients know where to (re)authorize. */
function bearerError(env: Env, status: number, error: string, description: string): Response {
  const attrs = [`realm="OAuth"`, `error="${error}"`, `error_description="${description}"`];
  attrs.push(`resource_metadata="${publicUrlOf(env)}/.well-known/oauth-protected-resource/mcp"`);
  if (status === 403) attrs.push('scope="moodle:read"');
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'WWW-Authenticate': `Bearer ${attrs.join(', ')}`,
    },
  });
}

/**
 * OAuth tokens: props were fixed at consent time, ctx.auth.scope is what the token carries now; the caller gets
 * the intersection. API keys (empty ctx.auth.scope) are bounded by their own stored scopes.
 */
function effectiveScopes(props: McpProps, ctx: ExecutionContext): McpProps['scopes'] {
  const tokenScopes = ((ctx as { auth?: { scope?: unknown } }).auth?.scope ?? []) as unknown[];
  const carried = tokenScopes.filter(isScope);
  return carried.length === 0 ? props.scopes : props.scopes.filter((s) => carried.includes(s));
}

function throttled(userId: number): Response | null {
  try {
    memoryRateLimit(`mcp:${userId}`, MCP_RATE_LIMIT, MCP_RATE_WINDOW_MS);
    return null;
  } catch {
    return new Response(JSON.stringify({ error: 'rate_limited', error_description: 'Too many requests. Slow down.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30', 'Cache-Control': 'no-store' },
    });
  }
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const base = readProps(ctx.props);
    if (!base) return bearerError(env, 401, 'invalid_token', 'This access token carries no account.');
    const props = { ...base, scopes: effectiveScopes(base, ctx) };
    if (!props.scopes.includes('moodle:read')) {
      return bearerError(env, 403, 'insufficient_scope', 'The moodle:read scope is required.');
    }
    const limited = throttled(props.userId);
    if (limited) return limited;

    let sctx: Awaited<ReturnType<typeof buildServiceContext>>;
    try {
      sctx = await buildServiceContext(env, ctx, props, { recordUsage: true });
    } catch (e) {
      // account deleted after the token was issued
      if (e instanceof NotFound)
        return bearerError(env, 401, 'invalid_token', 'The account for this token no longer exists.');
      if (e instanceof WmmError)
        return Response.json({ error: 'server_error', error_description: e.message }, { status: 500 });
      throw e;
    }

    // A fresh McpServer per request (stateless): the SDK refuses to serve one instance twice.
    const handler = createMcpHandler(() => buildMcpServer(sctx), { legacy: 'stateless', responseMode: 'auto' });
    return handler.fetch(request);
  },
};
