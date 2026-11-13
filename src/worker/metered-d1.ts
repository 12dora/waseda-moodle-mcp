/**
 * D1 that charges every query to the invocation budget before it runs (a batch: one per statement), so the
 * scheduled run stops cleanly with BudgetExceeded instead of hitting the Free plan's per-invocation query limit.
 */

import type { InvocationBudget } from '../core/budget';

const RUNS = new Set<PropertyKey>(['first', 'all', 'run', 'raw']);

/** Methods are bound to the real object (workerd's objects keep internal state the proxy cannot reach). */
function bound<T extends object>(target: T, prop: PropertyKey): unknown {
  const value = Reflect.get(target, prop, target);
  return typeof value === 'function' ? value.bind(target) : value;
}

/** Charges `n` queries, then runs; over budget it rejects without running (like any failed query). */
function charged<T>(budget: InvocationBudget, n: number, run: () => T): T | Promise<never> {
  try {
    budget.spendQueries(n);
  } catch (e) {
    return Promise.reject(e);
  }
  return run();
}

export function meterD1(db: D1Database, budget: InvocationBudget): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();

  const statement = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => statement(target.bind(...values));
        const value = bound(target, prop);
        if (!RUNS.has(prop) || typeof value !== 'function') return value;
        return (...args: unknown[]) => charged(budget, 1, () => value(...args));
      },
    });
    originals.set(proxy, stmt);
    return proxy;
  };

  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => statement(target.prepare(sql));
      if (prop === 'batch') {
        return (stmts: D1PreparedStatement[]) =>
          charged(budget, stmts.length, () => target.batch(stmts.map((s) => originals.get(s) ?? s)));
      }
      if (prop === 'exec') {
        return (sql: string) => charged(budget, 1, () => target.exec(sql));
      }
      return bound(target, prop);
    },
  });
}
