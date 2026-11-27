/**
 * Credential keepalive, first on every cron run (hourly around the clock; the night runs do nothing else). Moodle ends
 * a web session after 4 h idle. A run first asks Moodle whether its mobile web service is on (the site flag), then
 * visits every stored session not used in the last KEEPALIVE_AFTER_MS, most idle first, within the invocation budget:
 * launch.php while the service is on and a private token is stored (which also renews the token), otherwise one
 * `core_session_touch`. Background work: no activity statistics, no user activity stamp; the outcomes only feed the
 * credential-health counters (one batch per run).
 */

import type { InvocationBudget } from '../core/budget';
import { mobileServiceEnabled } from '../core/moodle/web/public-config';
import { keepSession, type RenewalOutcome } from '../core/services/credential-renewal';
import { type DayCount, renewalCounts } from '../core/usage';
import { getRuntime, renewalDeps } from './context';
import type { Env } from './env';
import { readMobileService, setMobileService } from './site-flag';
import type { D1Store } from './store-d1';

export const RENEW_MAX_USERS = 30;
/** A session used more recently than this is skipped (runs are an hour apart, the idle limit is 4 h). */
const KEEPALIVE_AFTER_MS = 45 * 60_000;

interface RenewalRunSummary {
  renewed: number;
  kept: number;
  ended: number;
  failed: number;
  skipped: number;
  /** Moodle requests of the session visits (the site check not included). */
  calls: number;
  /** Failure / skip reasons with their counts (Moodle error codes or short tags; never secrets). */
  reasons: Record<string, number>;
}

/** What the run must leave of the invocation budget (the course sweep that follows). */
interface Reserve {
  moodle: number;
  queries: number;
}

function tally(summary: RenewalRunSummary, outcome: RenewalOutcome): void {
  summary[outcome.status] += 1;
  summary.calls += outcome.calls;
  if (outcome.reason) summary.reasons[outcome.reason] = (summary.reasons[outcome.reason] ?? 0) + 1;
}

/** The site flag as Moodle reports it now, stored when it changed; the stored value while Moodle cannot say. */
async function checkMobileService(store: D1Store, doFetch: typeof fetch): Promise<boolean> {
  const stored = await readMobileService(store);
  const reported = await mobileServiceEnabled(doFetch);
  if (reported === null || reported === stored) return stored;
  await setMobileService(store, reported);
  return reported;
}

/**
 * Checks the site flag, then keeps the most idle sessions while the invocation budget, minus `reserve`, still fits the
 * next visit (the others are the most idle ones of the next run). `env.DB` is the invocation's metered D1.
 */
export async function runRenewal(
  env: Env,
  budget: InvocationBudget,
  reserve: Reserve = { moodle: 0, queries: 0 },
  now = Date.now(),
): Promise<RenewalRunSummary> {
  const summary: RenewalRunSummary = { renewed: 0, kept: 0, ended: 0, failed: 0, skipped: 0, calls: 0, reasons: {} };
  if (!budget.fits(1, 2)) return summary; // the site check: one request, one read and at most one write
  const rt = await getRuntime(env);
  const doFetch = budget.meter((input, init) => globalThis.fetch(input, init));
  const mobileService = await checkMobileService(rt.store, doFetch);

  const counts: DayCount[] = [];
  // the counters go in one batch at the end, one summed upsert per (metric, dim): room for those seen so far plus one
  // more this visit may add
  const counterQueries = () => new Set(counts.map((c) => `${c.metric}|${c.dim}`)).size + 1;
  const room = (moodle: number, queries: number): boolean =>
    budget.fits(moodle + reserve.moodle, queries + reserve.queries + counterQueries());
  if (!room(1, 3)) return summary;
  const candidates = await rt.store.listRenewalCandidates({
    visitedBefore: now - KEEPALIVE_AFTER_MS,
    limit: RENEW_MAX_USERS,
  });
  const deps = { ...renewalDeps(rt), fetch: doFetch };
  for (const { user, credential } of candidates) {
    if (!room(1, 2)) break;
    const outcome = await keepSession(deps, user, credential, { mobileService, room });
    tally(summary, outcome);
    counts.push(...renewalCounts(outcome));
  }
  if (counts.length > 0) await rt.store.recordCounts(now, counts).catch(() => undefined);
  if (summary.failed > 0) console.error('keepalive failed:', JSON.stringify(summary.reasons));
  return summary;
}
