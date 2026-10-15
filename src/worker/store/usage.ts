/**
 * Aggregate usage statistics (write path): per-day tool/client counters plus de-duplicated active-user counts for the
 * current day, week and month. No user id is ever stored: de-duplication keys are HMACs under a random per-period
 * salt, and keys and salt are deleted once their period has ended (purgeUsage), so finished periods link to nobody.
 */

import { jstDay, USAGE_COUNTS_RETENTION_MS, type UsagePeriods, usagePeriods } from '../../core/usage';
import { changes } from './rows';

export interface ToolCall {
  userId: number;
  /** Fixed label from clientLabel(). */
  client: string;
  tool: string;
  ok: boolean;
  now: number;
}

export interface UsageMethods {
  /** Counts one tool call. Aggregate only; callers wrap it in `defer`. */
  recordToolCall(call: ToolCall): Promise<void>;
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

/** The period's salt: created on first use (INSERT OR IGNORE, so concurrent isolates agree on the stored one). */
async function periodKey(db: D1Database, period: string): Promise<PeriodKey> {
  const cached = saltCache.get(period);
  if (cached) return cached;
  const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare('INSERT OR IGNORE INTO usage_salts (period, salt) VALUES (?, ?)').bind(period, fresh).run();
  const row = await db.prepare('SELECT salt FROM usage_salts WHERE period = ?').bind(period).first<{ salt: string }>();
  const salt = row?.salt ?? fresh;
  const entry = { salt, key: await importSalt(salt) };
  if (saltCache.size >= 16) saltCache.clear();
  saltCache.set(period, entry);
  return entry;
}

async function seenKey(pk: PeriodKey, subject: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', pk.key, enc.encode(subject)));
  return toHex(mac).slice(0, KEY_HEX_CHARS);
}

const bump = (db: D1Database, period: string, metric: string, dim: string): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO usage_counts (period, metric, dim, value) VALUES (?, ?, ?, 1)
       ON CONFLICT(period, metric, dim) DO UPDATE SET value = value + 1`,
    )
    .bind(period, metric, dim);

function callCounters(db: D1Database, day: string, c: ToolCall): D1PreparedStatement[] {
  const out = [bump(db, day, 'calls', c.tool), bump(db, day, 'client_calls', c.client)];
  if (!c.ok) out.push(bump(db, day, 'errors', c.tool));
  return out;
}

interface Pending {
  period: string;
  metric: 'active' | 'client_active';
  dim: string;
  memo: string;
  subject: string;
}

/** The (period, metric) pairs this isolate has not yet recorded for the user. */
function pendingSeen(p: UsagePeriods, c: ToolCall): Pending[] {
  const out: Pending[] = [];
  for (const period of [p.day, p.week, p.month]) {
    out.push({ period, metric: 'active', dim: '', memo: `${period}|${c.userId}|`, subject: `${c.userId}|` });
    out.push({
      period,
      metric: 'client_active',
      dim: c.client,
      memo: `${period}|${c.userId}|${c.client}`,
      subject: `${c.userId}|${c.client}`,
    });
  }
  return out.filter((x) => !seenMemo.has(x.memo));
}

/** Registers first sightings in usage_seen and counts the ones that were new to the period. */
async function recordActive(db: D1Database, p: UsagePeriods, c: ToolCall): Promise<void> {
  const todo = pendingSeen(p, c);
  if (todo.length === 0) return;
  const inserts: D1PreparedStatement[] = [];
  for (const x of todo) {
    const key = await seenKey(await periodKey(db, x.period), x.subject);
    inserts.push(db.prepare('INSERT OR IGNORE INTO usage_seen (period, key) VALUES (?, ?)').bind(x.period, key));
  }
  const res = await db.batch(inserts);
  const counts = todo.filter((_, i) => res[i]?.meta?.changes === 1).map((x) => bump(db, x.period, x.metric, x.dim));
  if (counts.length > 0) await db.batch(counts);
  if (seenMemo.size + todo.length > MEMO_CAP) seenMemo.clear();
  for (const x of todo) seenMemo.add(x.memo);
}

export function usageMethods(db: D1Database): UsageMethods {
  return {
    async recordToolCall(c) {
      const p = usagePeriods(c.now);
      await db.batch(callCounters(db, p.day, c));
      await recordActive(db, p, c);
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
