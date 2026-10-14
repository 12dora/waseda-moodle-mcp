/**
 * Scheduled course sweep (contract §12.4): every hourly run walks the users with an active credential, oldest-checked
 * first, and lets the sweep service refresh at most a couple of stale courses each. The whole invocation stays under
 * the Free plan's 50-subrequest limit by capping the Moodle calls it may spend in total.
 */

import type { MoodleApi, ServiceContext, UserRow } from '../core/context';
import { BudgetExceeded, NeedsReconnect } from '../core/errors';
import { sweepForCron } from '../core/services/sweep';
import { buildServiceContext, getRuntime, type WaitUntil } from './context';
import type { Env } from './env';

export const SWEEP_MAX_USERS = 20;
const SWEEP_MAX_REFRESH = 2;
/** Moodle calls one invocation may spend (Free plan: 50 subrequests, the rest is D1/KV and bookkeeping). */
export const SWEEP_CALL_BUDGET = 44;
/** A user is not started with fewer calls than this left (a full refetch plus its update checks). */
const MIN_CALLS_PER_USER = 6;
const SWEEP_SOURCE = 'Scheduled sweep';

interface SweepRunSummary {
  swept: number;
  skipped: number;
  failed: number;
  calls: number;
}

type UserOutcome = 'swept' | 'skipped' | 'failed' | 'budget';

async function sweepUser(
  env: Env,
  execCtx: WaitUntil | undefined,
  user: UserRow,
  maxCalls: number,
): Promise<{ outcome: UserOutcome; calls: number }> {
  let client: MoodleApi | undefined;
  const spent = () => client?.callsMade ?? 0;
  try {
    const base = await buildServiceContext(
      env,
      execCtx,
      { userId: user.id, scopes: ['moodle:read'], source: SWEEP_SOURCE },
      { user, maxCalls, touchUser: false },
    );
    // remembers the client so the calls it made can be added to the invocation's budget
    const ctx: ServiceContext = {
      ...base,
      moodle: async () => {
        client = await base.moodle();
        return client;
      },
    };
    await sweepForCron(ctx, { maxRefresh: SWEEP_MAX_REFRESH });
    return { outcome: 'swept', calls: spent() };
  } catch (e) {
    if (e instanceof NeedsReconnect) return { outcome: 'skipped', calls: spent() };
    if (e instanceof BudgetExceeded) return { outcome: 'budget', calls: spent() };
    console.error('sweep failed:', e instanceof Error ? e.name : 'unknown');
    return { outcome: 'failed', calls: spent() };
  }
}

export async function runCourseSweep(env: Env, execCtx?: WaitUntil): Promise<SweepRunSummary> {
  const summary: SweepRunSummary = { swept: 0, skipped: 0, failed: 0, calls: 0 };
  const { store } = await getRuntime(env);
  for (const user of await store.listSweepUsers(SWEEP_MAX_USERS)) {
    const remaining = SWEEP_CALL_BUDGET - summary.calls;
    if (remaining < MIN_CALLS_PER_USER) break;
    const { outcome, calls } = await sweepUser(env, execCtx, user, remaining);
    summary.calls += calls;
    if (outcome === 'budget') break;
    summary[outcome] += 1;
  }
  return summary;
}
