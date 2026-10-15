/** Operator usage report: reads the aggregate counters (`usage_counts`) and `users`; nothing per-user leaves it. */

import { jstDay, usagePeriods } from '../../core/usage';

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;

export interface UsageStats {
  generatedAt: number;
  days: number;
  users: { total: number; newInRange: number; activeToday: number; activeWeek: number; activeMonth: number };
  daily: { day: string; active: number; calls: number; errors: number; newUsers: number }[];
  tools: { name: string; calls: number; errors: number }[];
  clients: { name: string; calls: number; activeMonth: number }[];
}

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

const byCallsThenName = <T extends { name: string; calls: number }>(a: T, b: T): number =>
  b.calls - a.calls || a.name.localeCompare(b.name, 'en');

/** Per-tool sums from `calls` / `errors` rows grouped by tool name. */
function toolTotals(rows: CountRow[]): UsageStats['tools'] {
  const map = new Map<string, { name: string; calls: number; errors: number }>();
  for (const r of rows) {
    const name = r.dim ?? '';
    const t = map.get(name) ?? { name, calls: 0, errors: 0 };
    if (r.metric === 'calls') t.calls = Number(r.total);
    else t.errors = Number(r.total);
    map.set(name, t);
  }
  return [...map.values()].sort(byCallsThenName);
}

/** Union of per-client calls in the range and this month's distinct users per client. */
function clientTotals(calls: CountRow[], activeMonth: CountRow[]): UsageStats['clients'] {
  const map = new Map<string, { name: string; calls: number; activeMonth: number }>();
  const client = (name: string) => {
    const c = map.get(name) ?? { name, calls: 0, activeMonth: 0 };
    map.set(name, c);
    return c;
  };
  for (const r of calls) client(r.dim ?? '').calls = Number(r.total);
  for (const r of activeMonth) client(r.dim ?? '').activeMonth = Number(r.total);
  return [...map.values()].sort(byCallsThenName);
}

export function usageReportMethods(db: D1Database): UsageReportMethods {
  return {
    async getUsageStats(days, now) {
      // JST has no DST, so stepping back whole 24 h lands on the previous calendar day
      const dayList = Array.from({ length: days }, (_, i) => jstDay(now - (days - 1 - i) * DAY_MS));
      const first = dayList[0] as string;
      const lo = `d:${first}`;
      const hi = `d:${dayList[days - 1]}`;
      const rangeStartMs = Date.parse(`${first}T00:00:00+09:00`);
      const periods = usagePeriods(now);

      const [totalR, newR, dailyR, toolR, clientR, activeR, clientActiveR] = await db.batch<Record<string, unknown>>([
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
             WHERE period BETWEEN ? AND ? AND metric IN ('calls', 'errors', 'active') GROUP BY period, metric`,
          )
          .bind(lo, hi),
        db
          .prepare(
            `SELECT dim, metric, SUM(value) AS total FROM usage_counts
             WHERE period BETWEEN ? AND ? AND metric IN ('calls', 'errors') GROUP BY dim, metric`,
          )
          .bind(lo, hi),
        db
          .prepare(
            `SELECT dim, metric, SUM(value) AS total FROM usage_counts
             WHERE period BETWEEN ? AND ? AND metric = 'client_calls' GROUP BY dim, metric`,
          )
          .bind(lo, hi),
        db
          .prepare(
            `SELECT period, metric, value AS total FROM usage_counts
             WHERE metric = 'active' AND dim = '' AND period IN (?, ?, ?)`,
          )
          .bind(periods.day, periods.week, periods.month),
        db
          .prepare(`SELECT dim, metric, value AS total FROM usage_counts WHERE metric = 'client_active' AND period = ?`)
          .bind(periods.month),
      ]);
      const rows = <T>(r: D1Result<Record<string, unknown>> | undefined): T[] => (r?.results ?? []) as T[];

      const newByDay = new Map(rows<{ day: string; total: number }>(newR).map((r) => [r.day, Number(r.total)]));
      const perDay = new Map<string, number>();
      for (const r of rows<CountRow>(dailyR)) perDay.set(`${r.period}|${r.metric}`, Number(r.total));
      const daily = dayList.map((day) => ({
        day,
        active: perDay.get(`d:${day}|active`) ?? 0,
        calls: perDay.get(`d:${day}|calls`) ?? 0,
        errors: perDay.get(`d:${day}|errors`) ?? 0,
        newUsers: newByDay.get(day) ?? 0,
      }));

      const active = new Map(rows<CountRow>(activeR).map((r) => [r.period, Number(r.total)]));
      return {
        generatedAt: now,
        days,
        users: {
          total: Number(rows<{ total: number }>(totalR)[0]?.total ?? 0),
          newInRange: daily.reduce((n, d) => n + d.newUsers, 0),
          activeToday: active.get(periods.day) ?? 0,
          activeWeek: active.get(periods.week) ?? 0,
          activeMonth: active.get(periods.month) ?? 0,
        },
        daily,
        tools: toolTotals(rows<CountRow>(toolR)),
        clients: clientTotals(rows<CountRow>(clientR), rows<CountRow>(clientActiveR)),
      };
    },
  };
}
