/**
 * Credential keepalive, first on every cron run (also on the night runs without a course sweep). Moodle ends a web
 * session after 4 h idle and the runs are at most 3 h apart, so a live session is due on every run unless it was
 * visited in the last KEEPALIVE_AFTER_MS. The least recently visited go first (a failing session rotates behind the
 * others; a session waiting to be opened gets its turn once its retry is due). One launch.php call per live session,
 * three to open one, all within the invocation budget. Background work: no activity statistics, no user activity
 * stamp; the outcomes only feed the credential-health counters (one batch per run).
 */

import type { InvocationBudget } from '../core/budget';
import {
  AUTOLOGIN_RETRY_MS,
  type RenewalOutcome,
  refreshCredential,
  SESSION_IDLE_MS,
} from '../core/services/credential-renewal';
import { type DayCount, renewalCounts } from '../core/usage';
import { getRuntime, renewalDeps } from './context';
import type { Env } from './env';

export const RENEW_MAX_USERS = 30;
/** A session confirmed more recently than this is skipped (ticks are at most 3 h apart, the idle limit is 4 h). */
const KEEPALIVE_AFTER_MS = 45 * 60_000;
/**
 * A session idle this long would pass the idle limit before the next run that also sweeps courses (those runs are at
 * most 2 h apart), so it may use the sweep's reserve: the keepalive comes first, the sweep takes what is left. One
 * already idle past the limit has most likely ended and waits within the normal share like any other.
 */
const URGENT_IDLE_MS = SESSION_IDLE_MS - 2 * 3_600_000 - 15 * 60_000;

function isUrgent(credential: { sessionEnc?: string | null; sessionOkAt?: number | null }, now: number): boolean {
  const idle = now - (credential.sessionOkAt ?? 0);
  return Boolean(credential.sessionEnc) && idle >= URGENT_IDLE_MS && idle < SESSION_IDLE_MS;
}

interface RenewalRunSummary {
  renewed: number;
  kept: number;
  failed: number;
  skipped: number;
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

/**
 * Visits the most urgent candidates (sessions closest to idling out, sessions waiting to be opened) while the
 * invocation budget, minus `reserve`, still fits the next step; a session past URGENT_IDLE_MS may use the reserve too.
 * `env.DB` is the invocation's metered D1.
 */
export async function runRenewal(
  env: Env,
  budget: InvocationBudget,
  reserve: Reserve = { moodle: 0, queries: 0 },
  now = Date.now(),
): Promise<RenewalRunSummary> {
  const summary: RenewalRunSummary = { renewed: 0, kept: 0, failed: 0, skipped: 0, calls: 0, reasons: {} };
  const counts: DayCount[] = [];
  // the counters go in one batch at the end, one summed upsert per (metric, dim): room for those seen so far plus one
  // more this refresh may add
  const counterQueries = () => new Set(counts.map((c) => `${c.metric}|${c.dim}`)).size + 1;
  const roomWith =
    (r: Reserve) =>
    (moodle: number, queries: number): boolean =>
      budget.fits(moodle + r.moodle, queries + r.queries + counterQueries());
  const room = roomWith(reserve);
  const anyRoom = roomWith({ moodle: 0, queries: 0 });
  if (!anyRoom(1, 3)) return summary;
  const rt = await getRuntime(env);
  const candidates = await rt.store.listRenewalCandidates({
    sessionBefore: now - KEEPALIVE_AFTER_MS,
    autologinBefore: now - AUTOLOGIN_RETRY_MS,
    sessionIdleMs: SESSION_IDLE_MS,
    autologinRetryMs: AUTOLOGIN_RETRY_MS,
    limit: RENEW_MAX_USERS,
  });
  const deps = { ...renewalDeps(rt), fetch: budget.meter((input, init) => globalThis.fetch(input, init)) };
  for (const { user, credential } of candidates) {
    const urgent = isUrgent(credential, now);
    const fits = urgent ? anyRoom : room;
    if (!fits(1, 2)) {
      if (urgent) break; // not even the whole budget is left
      continue; // an urgent session further down may still use the reserve
    }
    const outcome = await refreshCredential(deps, user, credential, { autologin: true, room: fits });
    tally(summary, outcome);
    counts.push(...renewalCounts(outcome));
  }
  if (counts.length > 0) await rt.store.recordCounts(now, counts).catch(() => undefined);
  if (summary.failed > 0) console.error('renewal failed:', JSON.stringify(summary.reasons));
  return summary;
}
