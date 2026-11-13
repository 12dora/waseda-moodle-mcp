/**
 * Credential keepalive, first on every cron run (also on the night runs without a course sweep). Moodle ends a web
 * session after 4 h idle and the runs are at most 3 h apart, so a live session is due on every run unless it was
 * visited in the last KEEPALIVE_AFTER_MS. The sessions that would idle out before the next run go first; the rest by
 * urgency (a failing session rotates behind the others; a session waiting to be opened gets its turn once its retry
 * is due, with the capacity the first ones leave). One launch.php call per live session, three to open one, all within
 * the invocation budget. Background work: no activity statistics, no user activity stamp; the outcomes only feed the
 * credential-health counters (one batch per run).
 */

import type { InvocationBudget } from '../core/budget';
import type { CredentialRow } from '../core/context';
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
/** The cron's runs (wrangler.jsonc `17 0-14,16,19,22-23 * * *`, UTC). */
const RUN_HOURS_UTC = [...Array.from({ length: 15 }, (_, h) => h), 16, 19, 22, 23];
const RUN_MINUTE_UTC = 17;
/** A run may start this much late. */
const RUN_SLACK_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;

/** The first scheduled run after `now`. */
function nextRunAfter(now: number): number {
  const day = new Date(now);
  day.setUTCHours(0, RUN_MINUTE_UTC, 0, 0);
  const runs = [0, 24].flatMap((d) => RUN_HOURS_UTC.map((h) => day.getTime() + (d + h) * HOUR_MS));
  return runs.find((at) => at > now) ?? now + HOUR_MS;
}

/**
 * The last visits of the sessions this run must keep: still within the idle limit, but past it before the next run
 * (with its slack) could visit them. They go first and may use the sweep's reserve. One already idle past the limit
 * has most likely ended and waits within the normal share like any other.
 */
function mustVisitWindow(now: number): { after: number; until: number } {
  return { after: now - SESSION_IDLE_MS, until: nextRunAfter(now) + RUN_SLACK_MS - SESSION_IDLE_MS };
}

type SessionState = Pick<CredentialRow, 'sessionEnc' | 'sessionOkAt' | 'sessionTriedAt'>;

function mustVisit(credential: SessionState, keep: { after: number; until: number }): boolean {
  const visited = Math.max(credential.sessionOkAt ?? 0, credential.sessionTriedAt ?? 0);
  return Boolean(credential.sessionEnc) && visited > keep.after && visited <= keep.until;
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
 * Visits the most urgent candidates (sessions closest to idling out, then sessions waiting to be opened) while the
 * invocation budget, minus `reserve`, still fits the next step; a session that must be visited before the next run
 * goes first and may use the reserve too.
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
  const keep = mustVisitWindow(now);
  const candidates = await rt.store.listRenewalCandidates({
    sessionBefore: now - KEEPALIVE_AFTER_MS,
    autologinBefore: now - AUTOLOGIN_RETRY_MS,
    sessionIdleMs: SESSION_IDLE_MS,
    autologinRetryMs: AUTOLOGIN_RETRY_MS,
    mustVisit: keep,
    limit: RENEW_MAX_USERS,
  });
  const deps = { ...renewalDeps(rt), fetch: budget.meter((input, init) => globalThis.fetch(input, init)) };
  for (const { user, credential } of candidates) {
    const urgent = mustVisit(credential, keep);
    const fits = urgent ? anyRoom : room;
    if (!fits(1, 2)) break; // the sessions that must be visited come first: nothing further down fits either
    const outcome = await refreshCredential(deps, user, credential, { autologin: true, room: fits });
    tally(summary, outcome);
    counts.push(...renewalCounts(outcome));
  }
  if (counts.length > 0) await rt.store.recordCounts(now, counts).catch(() => undefined);
  if (summary.failed > 0) console.error('renewal failed:', JSON.stringify(summary.reasons));
  return summary;
}
