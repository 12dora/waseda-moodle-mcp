/**
 * OAuth consent glue: `/authorize` parks the parsed request (encrypted, in D1) and hands the browser to the SPA
 * consent page, which approves or denies it. The request is bound to the browser that started it by a cookie.
 */

import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { type Context, Hono } from 'hono';
import { randomId } from '../../core/crypto';
import { Forbidden, InvalidInput, NotFound } from '../../core/errors';
import type { Scope } from '../../core/types';
import { type AppEnv, hostCookie, readCookie } from '../auth';
import { getRuntime } from '../context';
import { isScope, publicUrlOf } from '../env';
import { auditConsole, cleanLabel, normalizeScopes, readJson, scopesFrom, session } from './shared';

const OAUTH_REQUEST_TTL_SEC = 600;
const OAUTH_COOKIE = '__Host-wmm_oauth';
const GENERIC_AUTHORIZE_ERROR = 'Invalid authorization request.';

interface PendingOAuthRequest {
  authRequest: AuthRequest;
  clientName: string;
  clientUri: string | null;
  /** Domain of a Client ID Metadata Document client; null for dynamically registered (unverified) clients. */
  clientDomain: string | null;
  verified: boolean;
  redirectHost: string;
  scopes: Scope[];
}

async function loadRequest(c: Context<AppEnv>, id: string, consume: boolean): Promise<PendingOAuthRequest> {
  const rt = await getRuntime(c.env);
  const now = Date.now();
  const enc = consume ? await rt.store.takeOAuthRequest(id, now) : await rt.store.getOAuthRequest(id, now);
  if (!enc) throw new NotFound('This authorization request has expired. Start again from your AI client.');
  return JSON.parse(await rt.key.decrypt(enc)) as PendingOAuthRequest;
}

/** Approve/deny only from the browser that opened /authorize (a link sent to someone else must not work). */
function assertStartedHere(c: Context<AppEnv>, id: string): void {
  if (readCookie(c.req.raw, OAUTH_COOKIE) !== id) {
    throw new Forbidden('This authorization request was not started in this browser.');
  }
}

function denyRedirect(req: AuthRequest): string {
  const u = new URL(req.redirectUri);
  u.searchParams.set('error', 'access_denied');
  u.searchParams.set('error_description', 'The user denied the request.');
  if (req.state) u.searchParams.set('state', req.state);
  if (req.issuer) u.searchParams.set('iss', req.issuer);
  return u.toString();
}

/** Only the library's own validation errors carry a message meant for the user; anything else stays generic. */
function authorizeErrorMessage(e: unknown): string {
  if (e instanceof Error && e.name === 'AuthorizationError') {
    const description = (e as { description?: unknown }).description;
    if (typeof description === 'string') return description;
  }
  return GENERIC_AUTHORIZE_ERROR;
}

/** Parses the provider's authorization request and parks it; returns the request id. */
async function stashAuthorizeRequest(c: Context<AppEnv>): Promise<string> {
  const oauth = c.env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(c.req.raw);
  const desc = await oauth.describeConsent(authRequest);
  const requested = authRequest.scope.filter(isScope);
  const rec: PendingOAuthRequest = {
    authRequest,
    clientName: cleanLabel(desc.clientName) || 'MCP client',
    clientUri: desc.clientUri ?? null,
    clientDomain: desc.clientDomain ?? null,
    verified: Boolean(desc.clientDomain),
    redirectHost: desc.redirectHost,
    scopes: normalizeScopes(requested.length ? requested : ['moodle:read']),
  };
  const rt = await getRuntime(c.env);
  const id = randomId('req', 16);
  const now = Date.now();
  await rt.store.putOAuthRequest({
    id,
    payloadEnc: await rt.key.encrypt(JSON.stringify(rec)),
    createdAt: now,
    expiresAt: now + OAUTH_REQUEST_TTL_SEC * 1000,
  });
  return id;
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
      const id = await stashAuthorizeRequest(c);
      c.header('Set-Cookie', hostCookie(OAUTH_COOKIE, id, OAUTH_REQUEST_TTL_SEC));
      return c.redirect(`${publicUrlOf(c.env)}/oauth/consent?req=${encodeURIComponent(id)}`, 302);
    } catch (e) {
      const redirectTo = (e as { redirectTo?: unknown } | null)?.redirectTo;
      if (typeof redirectTo === 'string') return c.redirect(redirectTo, 302);
      return c.json({ error: 'invalid_request', error_description: authorizeErrorMessage(e) }, 400);
    }
  });

  app.get('/api/oauth/requests/:id', session, async (c) => {
    const rec = await loadRequest(c, c.req.param('id'), false);
    return c.json({
      clientName: rec.clientName,
      clientUri: rec.clientUri,
      clientDomain: rec.clientDomain,
      verified: rec.verified,
      redirectHost: rec.redirectHost,
      scopes: rec.scopes,
    });
  });

  app.post('/api/oauth/requests/:id/approve', session, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    assertStartedHere(c, id);
    const body = await readJson(c);
    const granted = grantedScopes(await loadRequest(c, id, false), body.scopes);
    const rec = await loadRequest(c, id, true); // single use: exactly one approval wins
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: rec.authRequest,
      userId: String(user.id),
      metadata: { clientName: rec.clientName },
      scope: granted,
      props: { userId: user.id, scopes: granted, source: rec.clientName },
    });
    auditConsole(c, user, 'oauth:authorize', { client: rec.clientName, scopes: granted });
    c.header('Set-Cookie', hostCookie(OAUTH_COOKIE, '', 0));
    return c.json({ redirectTo });
  });

  app.post('/api/oauth/requests/:id/deny', session, async (c) => {
    const id = c.req.param('id');
    assertStartedHere(c, id);
    const rec = await loadRequest(c, id, true);
    c.header('Set-Cookie', hostCookie(OAUTH_COOKIE, '', 0));
    return c.json({ redirectTo: denyRedirect(rec.authRequest) });
  });

  return app;
}
