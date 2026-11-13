/**
 * What one Worker invocation may still spend, shared by all of its parts (scheduled run: purge, credential keepalive,
 * course sweep). Workers Free allows 50 subrequests and 50 D1 queries per invocation.
 */

import { BudgetExceeded } from './errors';

export class InvocationBudget {
  constructor(
    private moodleLeft: number,
    private queriesLeft: number,
  ) {}

  get moodle(): number {
    return this.moodleLeft;
  }

  get queries(): number {
    return this.queriesLeft;
  }

  /** Whether a unit of work needing this much can still start. */
  fits(moodle: number, queries: number): boolean {
    return this.moodleLeft >= moodle && this.queriesLeft >= queries;
  }

  /** Charges one Moodle request; throws BudgetExceeded (nothing charged) when none is left. */
  spendMoodle(): void {
    if (this.moodleLeft < 1) throw new BudgetExceeded();
    this.moodleLeft -= 1;
  }

  /** Charges `n` D1 queries; throws BudgetExceeded (nothing charged) when they do not fit. */
  spendQueries(n = 1): void {
    if (this.queriesLeft < n) throw new BudgetExceeded();
    this.queriesLeft -= n;
  }

  /** A fetch that charges one Moodle request before each call. */
  meter(doFetch: typeof fetch): typeof fetch {
    return (input, init) => {
      try {
        this.spendMoodle();
      } catch (e) {
        return Promise.reject(e);
      }
      return doFetch(input, init);
    };
  }
}
