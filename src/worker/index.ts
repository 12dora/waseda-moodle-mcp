/**
 * Worker entry. `workers-oauth-provider` is the front door:
 *   /mcp (+ bearer auth: OAuth tokens and `wmm_` API keys) -> mcpApiHandler
 *   /token, /register, /.well-known/*                      -> the provider itself
 *   everything else (/authorize, /api/*, /f/*, /u/*, /health) -> the Hono app (defaultHandler)
 * The provider is configured from env (PUBLIC_URL), so it is built lazily once per isolate.
 */

import OAuthProvider, { type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { InvocationBudget } from '../core/budget';
import { RateLimited } from '../core/errors';
import { createApi } from './api';
import { clientIp, rateLimit, resolveApiKey } from './auth';
import { makeDefer } from './context';
import { type Env, publicUrlOf } from './env';
import { runMailIdle } from './mail-idle';
import { mcpApiHandler } from './mcp';
import { meterD1 } from './metered-d1';
import { runRenewal } from './renew-cron';
import { logRequest } from './request-log';
import { createD1Store } from './store-d1';
import { runCourseSweep, SCHEDULED_QUERY_BUDGET, SWEEP_CALL_BUDGET } from './sweep-cron';

const PURGE_CURSOR_KEY = 'purge-cursor';
const ACCESS_TOKEN_TTL_SEC = 43_200; // 12 h: fewer refreshes = fewer KV writes (Free: 1000/day)
const REFRESH_TOKEN_TTL_SEC = 7_776_000; // 90 d
const PURGE_BATCH = 25;
const PURGE_HOUR_UTC = 3;
const PURGE_MINUTE_UTC = 17;
/** The night runs, 15–21 UTC (00–06 JST), only keep the Moodle web sessions alive: everything else runs 07–24 JST. */
const NIGHT_UTC = { first: 15, last: 21 };
/** What the keepalive leaves for the course sweep on a daytime run. */
const SWEEP_RESERVE = { moodle: 14, queries: 20 };

const api = createApi();

/** Request -> ExecutionContext, so the external-token resolver (which only receives the request) can defer writes. */
const executionByRequest = new WeakMap<Request, ExecutionContext>();

type ProviderOptions = OAuthProviderOptions<Env> & {
  resolveExternalToken: NonNullable<OAuthProviderOptions<Env>['resolveExternalToken']>;
};

export function buildProviderOptions(env: Env): ProviderOptions {
  const publicUrl = publicUrlOf(env);
  const resource = `${publicUrl}/mcp`;
  return {
    apiRoute: '/mcp',
    apiHandler: mcpApiHandler,
    defaultHandler: { fetch: (request, e, ctx) => api.fetch(request, e, ctx) },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: ['moodle:read', 'moodle:write'],
    // both scopes are advertised in the 401 challenge so clients ask for write too; the consent page can downgrade
    requiredScopes: ['moodle:read', 'moodle:write'],
    resourceMetadata: {
      resource,
      authorization_servers: [publicUrl],
      bearer_methods_supported: ['header'],
      resource_name: 'Waseda Moodle MCP',
    },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: ACCESS_TOKEN_TTL_SEC,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SEC,
    // Only reached after the provider's own token lookup missed: personal API keys (`wmm_` + base62).
    resolveExternalToken: async ({ token, request, env: e }) => {
      if (!token.startsWith('wmm_')) return null;
      const ctx = executionByRequest.get(request);
      const props = await resolveApiKey(createD1Store(e.DB), token, ctx ? makeDefer(ctx) : undefined);
      if (!props) return null;
      return { props, audience: resource };
    },
  };
}

const providers = new Map<string, OAuthProvider<Env>>();

export function providerFor(env: Env): OAuthProvider<Env> {
  const key = publicUrlOf(env);
  let p = providers.get(key);
  if (!p) {
    p = new OAuthProvider<Env>(buildProviderOptions(env));
    providers.set(key, p);
  }
  return p;
}

/** Daily maintenance: D1 retention, then one bounded sweep of the OAuth KV namespace (cursor persisted in KV). */
async function runPurge(env: Env, now = Date.now()): Promise<void> {
  try {
    await createD1Store(env.DB).purgeExpired(now);
  } catch (e) {
    console.error('purge d1 failed:', e instanceof Error ? e.message : 'unknown');
  }
  try {
    const cursor = (await env.OAUTH_KV.get(PURGE_CURSOR_KEY)) ?? undefined;
    const res = await providerFor(env).purgeExpiredData(env, { batchSize: PURGE_BATCH, cursor });
    if (res.done || !res.cursor) {
      if (cursor !== undefined) await env.OAUTH_KV.delete(PURGE_CURSOR_KEY);
    } else {
      await env.OAUTH_KV.put(PURGE_CURSOR_KEY, res.cursor, { expirationTtl: 7 * 86_400 });
    }
  } catch (e) {
    console.error('purge kv failed:', e instanceof Error ? e.message : 'unknown');
  }
}

/** The hourly cron (`17 * * * *`) also carries the daily purge, on its 03:17 UTC run only. */
export function isPurgeRun(scheduledTime: number): boolean {
  const at = new Date(scheduledTime);
  return at.getUTCHours() === PURGE_HOUR_UTC && at.getUTCMinutes() === PURGE_MINUTE_UTC;
}

/** Whether this run also sweeps courses (07–24 JST). */
function isDayRun(scheduledTime: number): boolean {
  const hour = new Date(scheduledTime).getUTCHours();
  return hour < NIGHT_UTC.first || hour > NIGHT_UTC.last;
}

/**
 * One cron run: the purge and the idle mail cleanup when it is the daily slot, the session keepalive, then, on a day
 * run, the course sweep.
 * All three spend ONE invocation budget of Moodle requests and D1 queries (D1 is metered here), so the run stays
 * under the Free plan's per-invocation limits. Each part survives the others' failure.
 */
export async function runScheduled(env: Env, scheduledTime: number, execCtx?: ExecutionContext): Promise<void> {
  const budget = new InvocationBudget(SWEEP_CALL_BUDGET, SCHEDULED_QUERY_BUDGET);
  const metered: Env = { ...env, DB: meterD1(env.DB, budget) };
  if (isPurgeRun(scheduledTime)) {
    await runPurge(metered);
    await runMailIdle(metered, budget);
  }
  const sweep = isDayRun(scheduledTime);
  try {
    await runRenewal(metered, budget, sweep ? SWEEP_RESERVE : undefined);
  } catch (e) {
    console.error('keepalive failed:', e instanceof Error ? e.name : 'unknown');
  }
  if (!sweep) return;
  try {
    await runCourseSweep(metered, execCtx, budget);
  } catch (e) {
    console.error('course sweep failed:', e instanceof Error ? e.name : 'unknown');
  }
}

/** Unauthenticated endpoints that cost KV writes inside the provider: throttled per IP before it runs. */
const PUBLIC_LIMITS: Record<string, { method: string; limit: number; windowMs: number }> = {
  '/authorize': { method: 'GET', limit: 60, windowMs: 10 * 60_000 },
  '/register': { method: 'POST', limit: 20, windowMs: 3_600_000 },
};

async function throttlePublic(request: Request, env: Env): Promise<Response | null> {
  const rule = PUBLIC_LIMITS[new URL(request.url).pathname];
  if (!rule || rule.method !== request.method) return null;
  try {
    const key = `public:${new URL(request.url).pathname}:${clientIp(request)}`;
    await rateLimit(createD1Store(env.DB), { key, limit: rule.limit, windowMs: rule.windowMs });
    return null;
  } catch (e) {
    if (!(e instanceof RateLimited)) return null;
    return Response.json(
      { error: 'temporarily_unavailable', error_description: 'Too many requests. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rule.windowMs / 1000)), 'Cache-Control': 'no-store' } },
    );
  }
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const limited = await throttlePublic(request, env);
  if (limited) return limited;
  executionByRequest.set(request, ctx);
  return providerFor(env).fetch(request, env, ctx);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    let status = 500;
    try {
      const res = await handle(request, env, ctx);
      status = res.status;
      return res;
    } finally {
      logRequest(request, status, Date.now() - started);
    }
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime, ctx));
  },
} satisfies ExportedHandler<Env>;
