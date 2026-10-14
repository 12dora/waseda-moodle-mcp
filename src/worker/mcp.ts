/**
 * `/mcp` API handler. workers-oauth-provider has already authenticated the caller (OAuth token or `wmm_` API key via
 * resolveExternalToken) and put `{userId, scopes, source}` into `ctx.props`.
 */

import { createMcpHandler } from '@modelcontextprotocol/server';
import { NotFound, WmmError } from '../core/errors';
import { buildMcpServer } from '../core/mcp/server';
import { buildServiceContext } from './context';
import { type Env, isScope, type McpProps } from './env';

function readProps(raw: unknown): McpProps | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.userId !== 'number' || !Number.isInteger(p.userId) || p.userId <= 0) return null;
  if (!Array.isArray(p.scopes)) return null;
  const scopes = p.scopes.filter(isScope);
  return { userId: p.userId, scopes, source: typeof p.source === 'string' && p.source ? p.source : 'MCP client' };
}

const BEARER_ERROR = (error: string, description: string, status: number) =>
  new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = readProps(ctx.props);
    if (!props) return BEARER_ERROR('invalid_token', 'This access token carries no account.', 401);
    if (!props.scopes.includes('moodle:read')) {
      return BEARER_ERROR('insufficient_scope', 'The moodle:read scope is required.', 403);
    }

    let sctx: Awaited<ReturnType<typeof buildServiceContext>>;
    try {
      sctx = await buildServiceContext(env, ctx, props);
    } catch (e) {
      // account deleted after the token was issued
      if (e instanceof NotFound)
        return BEARER_ERROR('invalid_token', 'The account for this token no longer exists.', 401);
      if (e instanceof WmmError) return BEARER_ERROR('server_error', e.message, 500);
      throw e;
    }

    // A fresh McpServer per request (stateless): the SDK refuses to serve one instance twice.
    const handler = createMcpHandler(() => buildMcpServer(sctx), { legacy: 'stateless', responseMode: 'auto' });
    return handler.fetch(request);
  },
};
