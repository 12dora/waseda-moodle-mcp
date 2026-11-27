/** Operator usage report: reads the aggregate counters (`usage_counts`), `users` and `credentials` counts only. */

import { FAILURE_CLASSES, jstDay, jstWeekStart, LATENCY_BUCKETS, usagePeriods, weeksBetween } from '../../core/usage';
import type { ActionFunnel, ChannelUsers, Cohort, DayStats, ToolStats, UsageStats } from '../../core/usage-stats';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const JST_OFFSET_MS = 9 * 3_600_000;
/**
 * Retention groups consecutive signup weeks within fixed blocks of this many weeks (counted from EPOCH_MONDAY), so a
 * group's boundaries never move as time passes or old weeks are purged. The report shows the previous and the
 * current block.
 */
const RETENTION_BLOCK_WEEKS = 12;
const EPOCH_MONDAY = Date.parse('1970-01-05T00:00:00+09:00');
/** A group closes once it has this many signups; a remainder that never reaches it is not reported at all. */
const MIN_COHORT = 3;

export interface UsageReportMethods {
  /** Aggregates for the last `days` JST days (today last). */
  getUsageStats(days: number, now: number): Promise<UsageStats>;
}

interface CountRow {
  period?: string;
  metric: string;
  dim?: string;
  total: number;
}

/** Per-day metrics summed over their dimension (the `daily` rows). */
const DAILY_METRICS = [
  'active',
  'active_web',
  'active_all',
  'calls',
  'errors',
  'page',
  'ics_fetches',
  'ics_feeds',
  'renew_renewed',
  'renew_kept',
  'renew_ended',
  'renew_failed',
  'connect',
];

/** Range metrics read per dimension. */
const BY_DIM = [
  'calls',
  'errors',
  'failure',
  'latency',
  'client_calls',
  'page',
  'hour_mcp',
  'hour_web',
  'renew_failed',
  'connect',
  'action_prepared',
  'action_executed',
  'action_failed',
  'action_cancelled',
  'action_expired',
  'action_superseded',
];

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

const byCallsThenName = <T extends { name: string; calls: number }>(a: T, b: T): number =>
  b.calls - a.calls || a.name.localeCompare(b.name, 'en');

/** dim -> total pairs, largest first, ties by name. */
const ranked = (dims: Map<string, number>): [string, number][] =>
  [...dims].sort(([an, a], [bn, b]) => b - a || an.localeCompare(bn, 'en'));

/** Range rows grouped by metric: dim -> total. */
function groupByMetric(rows: CountRow[]): (metric: string) => Map<string, number> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = out.get(r.metric) ?? new Map<string, number>();
    m.set(r.dim ?? '', Number(r.total));
    out.set(r.metric, m);
  }
  return (metric) => out.get(metric) ?? new Map();
}

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** Splits `<tool>|<part>` dims into tool -> part -> total, keeping only parts of the vocabulary. */
function perTool<K extends string>(dims: Map<string, number>, vocab: readonly K[]): Map<string, Record<K, number>> {
  const out = new Map<string, Record<K, number>>();
  for (const [dim, total] of dims) {
    const cut = dim.lastIndexOf('|');
    const part = vocab.find((k) => k === dim.slice(cut + 1));
    if (cut < 0 || !part) continue;
    const tool = dim.slice(0, cut);
    const rec = out.get(tool) ?? zeros(vocab);
    rec[part] += total;
    out.set(tool, rec);
  }
  return out;
}

function toolTotals(dim: (metric: string) => Map<string, number>): ToolStats[] {
  const calls = dim('calls');
  const errors = dim('errors');
  const failures = perTool(dim('failure'), FAILURE_CLASSES);
  const latency = perTool(dim('latency'), LATENCY_BUCKETS);
  return [...new Set([...calls.keys(), ...errors.keys()])]
    .map((name) => ({
      name,
      calls: calls.get(name) ?? 0,
      errors: errors.get(name) ?? 0,
      failures: failures.get(name) ?? zeros(FAILURE_CLASSES),
      latency: latency.get(name) ?? zeros(LATENCY_BUCKETS),
    }))
    .sort(byCallsThenName);
}

/** Union of per-client calls in the range and this month's distinct users per client. */
function clientTotals(calls: Map<string, number>, activeMonth: CountRow[]): UsageStats['clients'] {
  const map = new Map<string, { name: string; calls: number; activeMonth: number }>();
  const client = (name: string) => {
    const c = map.get(name) ?? { name, calls: 0, activeMonth: 0 };
    map.set(name, c);
    return c;
  };
  for (const [name, n] of calls) client(name).calls = n;
  for (const r of activeMonth) client(r.dim ?? '').activeMonth = Number(r.total);
  return [...map.values()].sort(byCallsThenName);
}

function hourly(dims: Map<string, number>): number[] {
  const out = Array.from({ length: 24 }, () => 0);
  for (const [dim, n] of dims) {
    const h = Number(dim);
    if (Number.isInteger(h) && h >= 0 && h < 24) out[h] = (out[h] ?? 0) + n;
  }
  return out;
}

function actionFunnel(dim: (metric: string) => Map<string, number>): ActionFunnel[] {
  const stages = ['prepared', 'executed', 'failed', 'cancelled', 'expired', 'superseded'] as const;
  const maps = stages.map((s) => [s, dim(`action_${s}`)] as const);
  const kinds = new Set(maps.flatMap(([, m]) => [...m.keys()]));
  return [...kinds]
    .map((kind) => ({ kind, ...Object.fromEntries(maps.map(([s, m]) => [s, m.get(kind) ?? 0])) }) as ActionFunnel)
    .sort((a, b) => b.prepared - a.prepared || a.kind.localeCompare(b.kind, 'en'));
}

const mondayOf = (weekIndex: number): string => jstWeekStart(EPOCH_MONDAY + weekIndex * WEEK_MS);

/** Week indexes (from EPOCH_MONDAY) of the current week and of the first week shown: the previous block's start. */
function retentionWeeks(now: number): { current: number; start: number } {
  const current = weeksBetween(EPOCH_MONDAY, now);
  return { current, start: current - (current % RETENTION_BLOCK_WEEKS) - RETENTION_BLOCK_WEEKS };
}

/**
 * Retention by signup group. Consecutive weeks merge (oldest first, never across a block boundary) until the group
 * has MIN_COHORT signups; the trailing remainder of a block is left out. Sizes and returns are both anonymous
 * counters (`signups` at account creation, `retained` at the first return), so deleting an account changes neither.
 * No per-week size is reported, so a left-out remainder cannot be derived from the groups shown.
 */
function cohorts(now: number, counters: CountRow[]): Cohort[] {
  const value = new Map(counters.map((r) => [`${r.period}|${r.metric}|${r.dim}`, Number(r.total)]));
  const { current, start } = retentionWeeks(now);
  const out: Cohort[] = [];
  let weeks: number[] = [];
  let users = 0;
  const close = () => {
    const last = weeks.at(-1) as number;
    const after = (offset: number) => {
      if (last + offset > current) return null;
      const back = weeks.reduce((n, w) => n + (value.get(`w:${mondayOf(w)}|retained|${offset}`) ?? 0), 0);
      return Math.min(users, back);
    };
    const from = mondayOf(weeks[0] as number);
    out.push({ from, to: mondayOf(last), users, w1: after(1), w2: after(2), w4: after(4) });
  };
  for (let w = start; w <= current; w++) {
    if ((w - start) % RETENTION_BLOCK_WEEKS === 0) {
      weeks = [];
      users = 0;
    }
    const signups = value.get(`w:${mondayOf(w)}|signups|`) ?? 0;
    if (weeks.length === 0 && signups === 0) continue; // a group starts with its first signup week
    weeks.push(w);
    users += signups;
    if (users >= MIN_COHORT) {
      close();
      weeks = [];
      users = 0;
    }
  }
  return out;
}

const channelsOf = (active: Map<string, number>, period: string): ChannelUsers => ({
  mcp: active.get(`${period}|active`) ?? 0,
  web: active.get(`${period}|active_web`) ?? 0,
  total: active.get(`${period}|active_all`) ?? 0,
});

type Rows = D1Result<Record<string, unknown>> | undefined;
const rowsOf = <T>(r: Rows): T[] => (r?.results ?? []) as T[];

/** The JST days of the report, oldest first; JST has no DST, so stepping back whole 24 h lands on the previous day. */
const reportDays = (days: number, now: number): string[] =>
  Array.from({ length: days }, (_, i) => jstDay(now - (days - 1 - i) * DAY_MS));

/** One batch: user totals, new users per day, the range counters, the current periods and the credential snapshot. */
async function readCounters(db: D1Database, dayList: string[], now: number) {
  const first = dayList[0] as string;
  const lo = `d:${first}`;
  const hi = `d:${dayList.at(-1)}`;
  const rangeStartMs = Date.parse(`${first}T00:00:00+09:00`);
  const periods = usagePeriods(now);
  const [total, created, daily, byDim, active, clientActive, credentials, cohort] = await db.batch<
    Record<string, unknown>
  >([
    db.prepare('SELECT COUNT(*) AS total FROM users'),
    db
      .prepare(
        `SELECT strftime('%Y-%m-%d', (created_at + ?) / 1000, 'unixepoch') AS day, COUNT(*) AS total
         FROM users WHERE created_at >= ? GROUP BY day`,
      )
      .bind(JST_OFFSET_MS, rangeStartMs),
    db
      .prepare(
        `SELECT period, metric, SUM(value) AS total FROM usage_counts
         WHERE period BETWEEN ? AND ? AND metric IN (${marks(DAILY_METRICS.length)}) GROUP BY period, metric`,
      )
      .bind(lo, hi, ...DAILY_METRICS),
    db
      .prepare(
        `SELECT dim, metric, SUM(value) AS total FROM usage_counts
         WHERE period BETWEEN ? AND ? AND metric IN (${marks(BY_DIM.length)}) GROUP BY metric, dim`,
      )
      .bind(lo, hi, ...BY_DIM),
    db
      .prepare(
        `SELECT period, metric, value AS total FROM usage_counts
         WHERE metric IN ('active', 'active_web', 'active_all') AND dim = '' AND period IN (?, ?, ?)`,
      )
      .bind(periods.day, periods.week, periods.month),
    db
      .prepare(`SELECT dim, metric, value AS total FROM usage_counts WHERE metric = 'client_active' AND period = ?`)
      .bind(periods.month),
    db.prepare(
      `SELECT TOTAL(status = 'active') AS active, TOTAL(status = 'invalid') AS invalid,
         TOTAL(session_enc IS NOT NULL) AS sessions
       FROM credentials`,
    ),
    db
      .prepare(
        `SELECT period, dim, metric, value AS total FROM usage_counts
         WHERE metric IN ('signups', 'retained') AND period BETWEEN ? AND ?`,
      )
      .bind(`w:${mondayOf(retentionWeeks(now).start)}`, periods.week),
  ]);
  return { periods, total, created, daily, byDim, active, clientActive, credentials, cohort };
}

function dailyStats(dayList: string[], created: Rows, counters: Rows): DayStats[] {
  const newByDay = new Map(rowsOf<{ day: string; total: number }>(created).map((r) => [r.day, Number(r.total)]));
  const perDay = new Map<string, number>();
  for (const r of rowsOf<CountRow>(counters)) perDay.set(`${r.period}|${r.metric}`, Number(r.total));
  return dayList.map((day): DayStats => {
    const at = (metric: string) => perDay.get(`d:${day}|${metric}`) ?? 0;
    return {
      day,
      active: at('active'),
      activeWeb: at('active_web'),
      activeAll: at('active_all'),
      calls: at('calls'),
      errors: at('errors'),
      newUsers: newByDay.get(day) ?? 0,
      webRequests: at('page'),
      icsFetches: at('ics_fetches'),
      icsFeeds: at('ics_feeds'),
      renewed: at('renew_renewed'),
      renewKept: at('renew_kept'),
      renewEnded: at('renew_ended'),
      renewFailed: at('renew_failed'),
      connects: at('connect'),
    };
  });
}

async function getUsageStats(db: D1Database, days: number, now: number): Promise<UsageStats> {
  const dayList = reportDays(days, now);
  const r = await readCounters(db, dayList, now);
  const { periods } = r;
  const daily = dailyStats(dayList, r.created, r.daily);
  const sum = (field: Exclude<keyof DayStats, 'day'>) => daily.reduce((n, d) => n + d[field], 0);
  const dim = groupByMetric(rowsOf<CountRow>(r.byDim));
  const active = new Map(rowsOf<CountRow>(r.active).map((x) => [`${x.period}|${x.metric}`, Number(x.total)]));
  const cred = rowsOf<{ active: number; invalid: number; sessions: number }>(r.credentials)[0];

  return {
    generatedAt: now,
    days,
    users: {
      total: Number(rowsOf<{ total: number }>(r.total)[0]?.total ?? 0),
      newInRange: sum('newUsers'),
      activeToday: active.get(`${periods.day}|active`) ?? 0,
      activeWeek: active.get(`${periods.week}|active`) ?? 0,
      activeMonth: active.get(`${periods.month}|active`) ?? 0,
    },
    daily,
    tools: toolTotals(dim),
    clients: clientTotals(dim('client_calls'), rowsOf<CountRow>(r.clientActive)),
    channels: {
      today: channelsOf(active, periods.day),
      week: channelsOf(active, periods.week),
      month: channelsOf(active, periods.month),
    },
    pages: ranked(dim('page')).map(([name, requests]) => ({ name, requests })),
    hours: { mcp: hourly(dim('hour_mcp')), web: hourly(dim('hour_web')) },
    credentials: {
      active: Number(cred?.active ?? 0),
      invalid: Number(cred?.invalid ?? 0),
      sessions: Number(cred?.sessions ?? 0),
      renewed: sum('renewed'),
      kept: sum('renewKept'),
      ended: sum('renewEnded'),
      failed: sum('renewFailed'),
      failures: ranked(dim('renew_failed')).map(([reason, count]) => ({ reason, count })),
      connects: ranked(dim('connect')).map(([via, count]) => ({ via, count })),
    },
    actions: actionFunnel(dim),
    retention: cohorts(now, rowsOf<CountRow>(r.cohort)),
  };
}

export function usageReportMethods(db: D1Database): UsageReportMethods {
  return { getUsageStats: (days, now) => getUsageStats(db, days, now) };
}
