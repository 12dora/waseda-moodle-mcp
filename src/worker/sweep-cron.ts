/**
 * Scheduled course sweep (contract §12.4): every daytime cron run walks the users with an active credential (never
 * swept first, then least recently attempted), and lets the refresh service update at most a couple of stale courses
 * each. The whole invocation stays under the Free plan's 50-subrequest limit by capping the Moodle calls it may
 * spend in total, and under its 10 ms CPU limit by refetching at most one large course; it makes no syllabus fetches
 * (cached rows only). The courses are the cron's own cheap scope plus, in auto mode, the ones the last interactive
 * call used.
 */

import { InvocationBudget } from '../core/budget';
import type { MoodleApi, ServiceContext, Store, UserRow } from '../core/context';
import { BudgetExceeded, NeedsReconnect } from '../core/errors';
import { type CourseScope, resolveScope } from '../core/services/scope';
import { CRON_MAX_AGE_MS, refreshSnapshots } from '../core/services/sweep/refresh';
import type { Course } from '../core/types';
import { buildServiceContext, getRuntime, type WaitUntil } from './context';
import type { Env } from './env';

export const SWEEP_MAX_USERS = 20;
const SWEEP_MAX_REFRESH = 2;
/**
 * Courses known to be large (> 100 KB raw) that ONE invocation may refetch: parsing one nears the Free CPU limit.
 * A course never fetched has an unknown size and counts as large, so it shares this allowance.
 */
const SWEEP_MAX_LARGE = 1;
/**
 * Moodle calls and D1 queries one scheduled invocation may spend (Free plan: 50 subrequests and 50 D1 queries; the
 * rest is margin for KV and bookkeeping), shared by the purge, the credential keepalive and the sweep.
 */
export const SWEEP_CALL_BUDGET = 44;
export const SCHEDULED_QUERY_BUDGET = 45;
/** A user is not started with fewer calls than this left (a full refetch plus its update checks). */
const MIN_CALLS_PER_USER = 6;
/** Nor with fewer D1 queries (stamp, snapshots, caches, writes); running dry mid-user ends the run cleanly. */
const MIN_QUERIES_PER_USER = 12;
/** Moodle calls one user's refresh may spend, after the scope calls. */
const REFRESH_CALLS_PER_USER = 12;
const SWEEP_SOURCE = 'Scheduled sweep';

interface SweepRunSummary {
  swept: number;
  skipped: number;
  failed: number;
  calls: number;
}

type UserOutcome = 'swept' | 'skipped' | 'failed' | 'budget';

/** What is left of the invocation's budgets when a user starts. */
interface Allowance {
  budget: InvocationBudget;
  maxLarge: number;
}

interface UserResult {
  outcome: UserOutcome;
  calls: number;
  large: number; // large courses refetched
}

/**
 * The cron's cheap scope plus, in auto mode, the courses the user's last interactive call used (with the calendar
 * signal and fresh syllabus lookups the cron lacks). A confirmed selection is the scope itself.
 */
function cronCourses(scope: CourseScope, user: UserRow): Course[] {
  const remembered = scope.mode === 'auto' ? new Set(user.scopeCourseIds) : new Set<number>();
  return scope.courses.filter((c) => scope.mine.has(c.id) || remembered.has(c.id));
}

async function sweepUser(
  env: Env,
  execCtx: WaitUntil | undefined,
  user: UserRow,
  allowance: Allowance,
): Promise<UserResult> {
  let client: MoodleApi | undefined;
  const tally = { large: 0 }; // kept current by the refresh, so a throw after a large parse still charges the budget
  const spent = () => client?.callsMade ?? 0;
  const maxCalls = allowance.budget.moodle;
  try {
    const base = await buildServiceContext(
      env,
      execCtx,
      { userId: user.id, scopes: ['moodle:read'], source: SWEEP_SOURCE },
      { user, maxCalls, budget: allowance.budget, touchUser: false },
    );
    // remembers the client so the calls it made can be added to the invocation's budget
    const ctx: ServiceContext = {
      ...base,
      moodle: async () => {
        client = await base.moodle();
        return client;
      },
    };
    // The cron fetches nothing public (syllabus rows come from the cache only) and skips the calendar signal, so a run
    // stays within its Moodle-call budget.
    const scope = await resolveScope(ctx, { syllabusLookup: false, calendarSignal: false });
    const targets = cronCourses(scope, user);
    if (targets.length === 0) return { outcome: 'swept', calls: spent(), large: 0 };
    const { large } = await refreshSnapshots(ctx, targets, {
      maxCalls: Math.min(REFRESH_CALLS_PER_USER, maxCalls - spent()),
      maxFull: SWEEP_MAX_REFRESH,
      maxLarge: allowance.maxLarge,
      maxAgeMs: CRON_MAX_AGE_MS,
      rememberScope: false,
      unknownIsLarge: true, // a never-fetched course may be large too: it takes the large slot
      tally,
    });
    return { outcome: 'swept', calls: spent(), large };
  } catch (e) {
    const calls = spent();
    const large = tally.large;
    if (e instanceof NeedsReconnect) return { outcome: 'skipped', calls, large };
    if (e instanceof BudgetExceeded) return { outcome: 'budget', calls, large };
    console.error('sweep failed:', e instanceof Error ? e.name : 'unknown');
    return { outcome: 'failed', calls, large };
  }
}

/** Stamped BEFORE the attempt, so a run killed by the CPU limit still moves the user to the back of the queue. */
async function stampSwept(store: Store, userId: number): Promise<void> {
  try {
    await store.markSwept(userId, Date.now());
  } catch {
    console.error('sweep stamp failed');
  }
}

/**
 * `budget` is what the invocation has left (the scheduled run shares it with the purge and the keepalive; its D1 is
 * metered through `env.DB`). Every Moodle request of the sweep's clients, renewals included, is charged to it.
 */
export async function runCourseSweep(
  env: Env,
  execCtx?: WaitUntil,
  budget = new InvocationBudget(SWEEP_CALL_BUDGET, SCHEDULED_QUERY_BUDGET),
): Promise<SweepRunSummary> {
  const summary: SweepRunSummary = { swept: 0, skipped: 0, failed: 0, calls: 0 };
  let largeLeft = SWEEP_MAX_LARGE; // one budget for the whole invocation, not per user
  if (!budget.fits(MIN_CALLS_PER_USER, MIN_QUERIES_PER_USER)) return summary;
  const { store } = await getRuntime(env);
  for (const user of await store.listSweepUsers(SWEEP_MAX_USERS)) {
    if (!budget.fits(MIN_CALLS_PER_USER, MIN_QUERIES_PER_USER)) break;
    await stampSwept(store, user.id);
    const { outcome, calls, large } = await sweepUser(env, execCtx, user, { budget, maxLarge: largeLeft });
    summary.calls += calls;
    largeLeft = Math.max(0, largeLeft - large);
    if (outcome === 'budget') break;
    summary[outcome] += 1;
  }
  return summary;
}
