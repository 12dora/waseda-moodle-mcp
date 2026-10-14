/** OAuth consent glue: `/authorize` hands the parsed request to the SPA consent page, which approves or denies it. */

import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { type Context, Hono } from 'hono';
import { randomId } from '../../core/crypto';
import { InvalidInput, NotFound } from '../../core/errors';
import type { Scope } from '../../core/types';
import type { AppEnv } from '../auth';
import { isScope, publicUrlOf } from '../env';
import { auditConsole, cleanLabel, normalizeScopes, readJson, scopesFrom, session } from './shared';

const OAUTH_REQUEST_TTL_SEC = 600;

interface PendingOAuthRequest {
  authRequest: AuthRequest;
  clientName: string;
  clientUri: string | null;
  redirectHost: string;
  scopes: Scope[];
}

const oauthKey = (id: string) => `oauthreq:${id}`;

async function loadRequest(c: Context<AppEnv>, id: string): Promise<PendingOAuthRequest> {
  const rec = await c.env.OAUTH_KV.get<PendingOAuthRequest>(oauthKey(id), 'json');
  if (!rec) throw new NotFound('This authorization request has expired. Start again from your AI client.');
  return rec;
}

function denyRedirect(req: AuthRequest): string {
  const u = new URL(req.redirectUri);
  u.searchParams.set('error', 'access_denied');
  u.searchParams.set('error_description', 'The user denied the request.');
  if (req.state) u.searchParams.set('state', req.state);
  if (req.issuer) u.searchParams.set('iss', req.issuer);
  return u.toString();
}

function errorMessage(e: unknown): string {
  const description = (e as { description?: unknown } | null)?.description;
  if (typeof description === 'string') return description;
  return e instanceof Error ? e.message : 'Invalid authorization request.';
}

/** Parses the provider's authorization request and parks it in KV; returns the consent page URL. */
async function stashAuthorizeRequest(c: Context<AppEnv>): Promise<string> {
  const oauth = c.env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(c.req.raw);
  const desc = await oauth.describeConsent(authRequest);
  const requested = authRequest.scope.filter(isScope);
  const id = randomId('req', 16);
  const rec: PendingOAuthRequest = {
    authRequest,
    clientName: cleanLabel(desc.clientName) || 'MCP client',
    clientUri: desc.clientUri ?? null,
    redirectHost: desc.redirectHost,
    scopes: normalizeScopes(requested.length ? requested : ['moodle:read']),
  };
  await c.env.OAUTH_KV.put(oauthKey(id), JSON.stringify(rec), { expirationTtl: OAUTH_REQUEST_TTL_SEC });
  return `${publicUrlOf(c.env)}/oauth/consent?req=${encodeURIComponent(id)}`;
}

/** What the user granted: their choice (default: everything requested) limited to what the client asked for. */
function grantedScopes(rec: PendingOAuthRequest, chosen: unknown): Scope[] {
  const allowed = scopesFrom(chosen, rec.scopes);
  const granted = normalizeScopes(allowed.filter((s) => rec.scopes.includes(s)));
  if (!granted.includes('moodle:read')) throw new InvalidInput('Read access is required to connect.');
  return granted;
}

export function oauthRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/authorize', async (c) => {
    try {
      return c.redirect(await stashAuthorizeRequest(c), 302);
    } catch (e) {
      const redirectTo = (e as { redirectTo?: unknown } | null)?.redirectTo;
      if (typeof redirectTo === 'string') return c.redirect(redirectTo, 302);
      return c.json({ error: 'invalid_request', error_description: errorMessage(e) }, 400);
    }
  });

  app.get('/api/oauth/requests/:id', session, async (c) => {
    const rec = await loadRequest(c, c.req.param('id'));
    return c.json({
      clientName: rec.clientName,
      clientUri: rec.clientUri,
      redirectHost: rec.redirectHost,
      scopes: rec.scopes,
    });
  });

  app.post('/api/oauth/requests/:id/approve', session, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const body = await readJson(c);
    const rec = await loadRequest(c, id);
    const granted = grantedScopes(rec, body.scopes);
    await c.env.OAUTH_KV.delete(oauthKey(id)); // single use
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: rec.authRequest,
      userId: String(user.id),
      metadata: { clientName: rec.clientName },
      scope: granted,
      props: { userId: user.id, scopes: granted, source: rec.clientName },
    });
    auditConsole(c, user, 'oauth:authorize', { client: rec.clientName, scopes: granted });
    return c.json({ redirectTo });
  });

  app.post('/api/oauth/requests/:id/deny', session, async (c) => {
    const id = c.req.param('id');
    const rec = await loadRequest(c, id);
    await c.env.OAUTH_KV.delete(oauthKey(id));
    return c.json({ redirectTo: denyRedirect(rec.authRequest) });
  });

  return app;
}
