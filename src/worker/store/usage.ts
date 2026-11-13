/**
 * Aggregate usage statistics (write path): per-day counters with fixed-vocabulary dimensions (tools, clients, failure
 * classes, latency buckets, console features, hours, credential and write-action events) plus de-duplicated
 * active-user counts per channel for the current day, week and month. No user id is ever stored: de-duplication keys
 * are HMACs under a random per-period salt, and keys and salt are deleted once their period has ended (purgeUsage), so
 * finished periods link to nobody. Retention is counted at record time into the signup week's aggregate counters.
 */

import {
  type DayCount,
  type FailureClass,
  jstDay,
  jstHour,
  jstWeekStart,
  latencyBucket,
  RETENTION_OFFSETS,
  USAGE_COUNTS_RETENTION_MS,
  type UsagePeriods,
  usagePeriods,
  weeksBetween,
} from '../../core/usage';
import { changes } from './rows';

/** Who acted, as far as the statistics need it: the id only feeds salted de-dup keys, signup only the cohort week. */
interface Actor {
  userId: number;
  /** users.created_at (retention cohort). */
  createdAt: number;
}

interface ToolCall extends Actor {
  /** Fixed label from clientLabel(). */
  client: string;
  tool: string;
  ms: number;
  failure: FailureClass | null;
  now: number;
}

interface WebRequest extends Actor {
  /** Fixed console feature label (api/console-usage.ts). */
  feature: string;
  now: number;
}

export interface UsageMethods {
  /** Counts one MCP tool call. Aggregate only; callers wrap it in `defer`. */
  recordToolCall(call: ToolCall): Promise<void>;
  /** Counts one user-initiated console API request (activity + feature + hour). */
  recordWebRequest(req: WebRequest): Promise<void>;
  /** Counts one served calendar feed (fetches + distinct feeds per day); never activity. */
  recordFeedFetch(fetch: { ownerId: number; now: number }): Promise<void>;
  /** Plain day counters (credential renewals, connects); repeats are summed into one upsert each. */
  recordCounts(now: number, counts: DayCount[]): Promise<void>;
}

const enc = new TextEncoder();
const KEY_HEX_CHARS = 32;
const MEMO_CAP = 5000;

interface PeriodKey {
  salt: string;
  key: CryptoKey;
}

// Isolate-level caches: they only save D1 round trips, the primary keys keep the counts right across isolates.
const saltCache = new Map<string, PeriodKey>();
const seenMemo = new Set<string>();

/** Test hook: forget what this isolate has already recorded (simulates another isolate). */
export function resetUsageMemory(): void {
  saltCache.clear();
  seenMemo.clear();
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function importSalt(salt: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/**
 * Salts of the given periods, cached per isolate. Uncached ones are created and read back in ONE batch (INSERT OR
 * IGNORE first, so concurrent isolates agree on the stored salt); a salt that is not stored is never used.
 */
async function periodKeys(db: D1Database, periods: string[]): Promise<Map<string, PeriodKey>> {
  const out = new Map<string, PeriodKey>();
  const missing = periods.filter((period) => {
    const cached = saltCache.get(period);
    if (cached) out.set(period, cached);
    return !cached;
  });
  if (missing.length === 0) return out;
  const creates = missing.map((period) =>
    db
      .prepare('INSERT OR IGNORE INTO usage_salts (period, salt) VALUES (?, ?)')
      .bind(period, toHex(crypto.getRandomValues(new Uint8Array(32)))),
  );
  const marks = missing.map(() => '?').join(', ');
  const read = db.prepare(`SELECT period, salt FROM usage_salts WHERE period IN (${marks})`).bind(...missing);
  const res = await db.batch([...creates, read]);
  const rows = (res[creates.length]?.results ?? []) as { period: string; salt: string }[];
  if (saltCache.size + missing.length > 16) saltCache.clear();
  for (const period of missing) {
    const salt = rows.find((r) => r.period === period)?.salt;
    if (!salt) throw new Error('usage salt missing');
    const entry = { salt, key: await importSalt(salt) };
    saltCache.set(period, entry);
    out.set(period, entry);
  }
  return out;
}

async function seenKey(pk: PeriodKey, subject: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', pk.key, enc.encode(subject)));
  return toHex(mac).slice(0, KEY_HEX_CHARS);
}

interface Count {
  period: string;
  metric: string;
  dim: string;
}

const UPSERT = `INSERT INTO usage_counts (period, metric, dim, value) VALUES (?, ?, ?, ?)
  ON CONFLICT(period, metric, dim) DO UPDATE SET value = value + excluded.value`;

/** One upsert per distinct counter, by how often it occurs in `counts` (a run's 30 "kept" are one write). */
function summedUpserts(db: D1Database, counts: Count[]): D1PreparedStatement[] {
  const sums = new Map<string, { c: Count; n: number }>();
  for (const c of counts) {
    const key = `${c.period}\n${c.metric}\n${c.dim}`;
    const hit = sums.get(key);
    if (hit) hit.n += 1;
    else sums.set(key, { c, n: 1 });
  }
  return [...sums.values()].map(({ c, n }) => db.prepare(UPSERT).bind(c.period, c.metric, c.dim, n));
}

const dayCounts = (day: string, counts: DayCount[]): Count[] => counts.map((c) => ({ period: day, ...c }));

function toolCounts(p: UsagePeriods, c: ToolCall): Count[] {
  const counts: DayCount[] = [
    { metric: 'calls', dim: c.tool },
    { metric: 'client_calls', dim: c.client },
    { metric: 'hour_mcp', dim: jstHour(c.now) },
    { metric: 'latency', dim: `${c.tool}|${latencyBucket(c.ms)}` },
  ];
  if (c.failure) counts.push({ metric: 'errors', dim: c.tool }, { metric: 'failure', dim: `${c.tool}|${c.failure}` });
  return dayCounts(p.day, counts);
}

/** A de-dup subject of one period: its counters move only when the salted key is new. */
interface Seen {
  period: string;
  /** Never stored: only its HMAC under the period salt is. */
  subject: string;
  /** Counted in order, each only if the previous statement changed a row (so all or none of them). */
  counts: Count[];
}

/** `count` is the subject's own counter in `period`; `chained` follow it. */
const seen = (
  period: string,
  subject: string,
  { metric, dim = '' }: { metric: string; dim?: string },
  chained: Count[] = [],
): Seen => ({
  period,
  subject,
  counts: [{ period, metric, dim }, ...chained],
});

/** Signup cohort bump when the user is first seen active (any channel) 1, 2 or 4 weeks after the signup week. */
function retained(a: Actor, now: number): Count[] {
  const offset = weeksBetween(a.createdAt, now);
  if (!RETENTION_OFFSETS.some((o) => o === offset)) return [];
  return [{ period: `w:${jstWeekStart(a.createdAt)}`, metric: 'retained', dim: String(offset) }];
}

type Channel = 'mcp' | 'web';
/** MCP keeps the original metric and subject, so its history continues unchanged. */
const CHANNEL = { mcp: { metric: 'active', tag: '' }, web: { metric: 'active_web', tag: '#web' } } as const;

/**
 * Active users of the day, week and month: per channel, and across channels (`active_all`, one person once however
 * many channels they use). The weekly cross-channel entry also feeds the retention cohorts.
 */
function activeSeen(p: UsagePeriods, a: Actor, channel: Channel, now: number): Seen[] {
  const { metric, tag } = CHANNEL[channel];
  return [p.day, p.week, p.month].flatMap((period) => [
    seen(period, `${a.userId}|${tag}`, { metric }),
    seen(period, `${a.userId}|#all`, { metric: 'active_all' }, period === p.week ? retained(a, now) : []),
  ]);
}

const memoOf = (x: Seen): string => `${x.period}|${x.subject}`;

/**
 * Per entry: remember the key, then count it only if that insert really added a row (`changes() = 1` refers to the
 * statement right before, on the same connection). Inside one batch the key and its counts succeed or fail together.
 */
async function seenStatements(db: D1Database, todo: Seen[]): Promise<D1PreparedStatement[]> {
  if (todo.length === 0) return [];
  const salts = await periodKeys(db, [...new Set(todo.map((x) => x.period))]);
  const out: D1PreparedStatement[] = [];
  for (const x of todo) {
    const pk = salts.get(x.period);
    if (!pk) throw new Error('usage salt missing');
    const key = await seenKey(pk, x.subject);
    out.push(db.prepare('INSERT OR IGNORE INTO usage_seen (period, key) VALUES (?, ?)').bind(x.period, key));
    for (const c of x.counts) {
      out.push(
        db
          .prepare(
            `INSERT INTO usage_counts (period, metric, dim, value) SELECT ?, ?, ?, 1 WHERE changes() = 1
             ON CONFLICT(period, metric, dim) DO UPDATE SET value = value + 1`,
          )
          .bind(c.period, c.metric, c.dim),
      );
    }
  }
  return out;
}

/** Counters plus the de-dup entries this isolate has not recorded yet, in ONE batch (memoised once it went through). */
async function record(db: D1Database, counts: Count[], entries: Seen[] = []): Promise<void> {
  const todo = entries.filter((x) => !seenMemo.has(memoOf(x)));
  const statements = [...summedUpserts(db, counts), ...(await seenStatements(db, todo))];
  if (statements.length === 0) return;
  await db.batch(statements);
  if (seenMemo.size + todo.length > MEMO_CAP) seenMemo.clear();
  for (const x of todo) seenMemo.add(memoOf(x));
}

export function usageMethods(db: D1Database): UsageMethods {
  return {
    async recordToolCall(c) {
      const p = usagePeriods(c.now);
      // the per-client split is kept for the month only (the only one the report reads)
      const client = seen(p.month, `${c.userId}|${c.client}`, { metric: 'client_active', dim: c.client });
      await record(db, toolCounts(p, c), [...activeSeen(p, c, 'mcp', c.now), client]);
    },

    async recordWebRequest(r) {
      const p = usagePeriods(r.now);
      const counts = dayCounts(p.day, [
        { metric: 'page', dim: r.feature },
        { metric: 'hour_web', dim: jstHour(r.now) },
      ]);
      await record(db, counts, activeSeen(p, r, 'web', r.now));
    },

    async recordFeedFetch(f) {
      const day = usagePeriods(f.now).day;
      const fetches = { period: day, metric: 'ics_fetches', dim: '' };
      await record(db, [fetches], [seen(day, `#ics|${f.ownerId}`, { metric: 'ics_feeds' })]);
    },

    async recordCounts(now, counts) {
      await record(db, dayCounts(usagePeriods(now).day, counts));
    },
  };
}

/**
 * Daily retention: counters older than 400 days go; dedup keys and salts survive only for the CURRENT day, week and
 * month. A period's date part is its day, its Monday, or (months) its first day.
 */
export async function purgeUsage(db: D1Database, now: number): Promise<Record<string, number>> {
  const p = usagePeriods(now);
  const cutoff = jstDay(now - USAGE_COUNTS_RETENTION_MS);
  const stale = (table: string) =>
    changes(db.prepare(`DELETE FROM ${table} WHERE period NOT IN (?, ?, ?)`).bind(p.day, p.week, p.month));
  return {
    usageCounts: await changes(
      db
        .prepare(
          `DELETE FROM usage_counts
           WHERE CASE WHEN period LIKE 'm:%' THEN substr(period, 3) || '-01' ELSE substr(period, 3) END < ?`,
        )
        .bind(cutoff),
    ),
    usageSeen: await stale('usage_seen'),
    usageSalts: await stale('usage_salts'),
  };
}
