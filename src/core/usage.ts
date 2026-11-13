/**
 * Usage-statistics vocabulary shared by the recorder (write path) and the operator report: JST periods, client
 * labels and the fixed dimensions of the finer counters. Pure.
 */

import { MoodleError, WmmError } from './errors';
import { jstParts } from './time';

const pad = (n: number) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' of an instant in Asia/Tokyo (fixed +09:00, no DST). */
export function jstDay(now: number): string {
  const p = jstParts(now);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

/** Monday of the JST week containing the instant, 'YYYY-MM-DD'. */
export function jstWeekStart(now: number): string {
  const p = jstParts(now);
  const sinceMonday = (p.wd + 6) % 7;
  return jstDay(Date.UTC(p.y, p.mo - 1, p.d - sinceMonday, 12)); // noon UTC = 21:00 JST, same calendar day in both
}

/** 'YYYY-MM' of an instant in Asia/Tokyo. */
export function jstMonth(now: number): string {
  const p = jstParts(now);
  return `${p.y}-${pad(p.mo)}`;
}

/** Keys of the `usage_counts` / `usage_seen` / `usage_salts` period column. */
export interface UsagePeriods {
  day: string;
  week: string;
  month: string;
}

export function usagePeriods(now: number): UsagePeriods {
  return { day: `d:${jstDay(now)}`, week: `w:${jstWeekStart(now)}`, month: `m:${jstMonth(now)}` };
}

/** `usage_counts` rows older than this are purged by the daily retention sweep. */
export const USAGE_COUNTS_RETENTION_MS = 400 * DAY_MS;

export const CLIENT_API_KEY = 'API key';
export const CLIENT_OTHER = 'Other';

interface ClientRule {
  label: string;
  /** Lower-case needles; any one matching selects the label. */
  needles: readonly string[];
  /** Match at the start of the source instead of anywhere in it. */
  prefix?: boolean;
}

/** Ordered, first match wins: the single source of the client vocabulary (labels never carry user-provided text). */
const CLIENT_RULES: readonly ClientRule[] = [
  { label: CLIENT_API_KEY, needles: ['api key:'], prefix: true },
  { label: 'Claude Code', needles: ['claude code'] },
  { label: 'Claude', needles: ['claude'] },
  { label: 'ChatGPT', needles: ['chatgpt', 'openai'] },
  { label: 'Cursor', needles: ['cursor'] },
  { label: 'VS Code', needles: ['visual studio code', 'vs code', 'vscode'] },
  { label: 'Codex', needles: ['codex'] },
  { label: 'Grok', needles: ['grok', 'xai'] },
  { label: 'Gemini', needles: ['gemini'] },
  { label: 'Windsurf', needles: ['windsurf'] },
  { label: 'LobeHub', needles: ['lobehub', 'lobechat'] },
  { label: 'Cherry Studio', needles: ['cherry studio'] },
  { label: 'Goose', needles: ['goose'] },
  { label: 'MCP Inspector', needles: ['mcp inspector'] },
];

/** Maps a free-form MCP source (OAuth client name or "API key: <name>") to a fixed label; never returns user-provided text. */
export function clientLabel(source: string): string {
  const s = source.trim().toLowerCase();
  const rule = CLIENT_RULES.find((r) => r.needles.some((n) => (r.prefix ? s.startsWith(n) : s.includes(n))));
  return rule?.label ?? CLIENT_OTHER;
}

// ------------------------------------------------------------------ fixed vocabularies of the finer statistics

/** Why a tool call failed, from the error class (single source: failureClass). */
export const FAILURE_CLASSES = [
  'needs_reconnect',
  'moodle_unavailable',
  'invalid_input',
  'forbidden',
  'budget',
  'other',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Error code (src/core/errors.ts) -> class. forbidden covers not_found; budget the call budget and rate limits. */
const FAILURE_BY_CODE: ReadonlyMap<string, FailureClass> = new Map<string, FailureClass>([
  ['needs_reconnect', 'needs_reconnect'],
  ['moodle_unavailable', 'moodle_unavailable'], // includes request timeouts
  ['invalid_input', 'invalid_input'],
  ['forbidden', 'forbidden'],
  ['not_found', 'forbidden'],
  ['budget_exceeded', 'budget'],
  ['rate_limited', 'budget'],
]);

/** Moodle's own error codes (MoodleError) and unexpected errors are `other`. */
export function failureClass(e: unknown): FailureClass {
  if (!(e instanceof WmmError) || e instanceof MoodleError) return 'other';
  return FAILURE_BY_CODE.get(e.code) ?? 'other';
}

/** Wall-time buckets of a tool handler: < 1 s, 1–3 s, 3–10 s, > 10 s. */
export const LATENCY_BUCKETS = ['lt1s', '1to3s', '3to10s', 'gt10s'] as const;
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number];

export function latencyBucket(ms: number): LatencyBucket {
  if (ms < 1000) return 'lt1s';
  if (ms < 3000) return '1to3s';
  if (ms < 10_000) return '3to10s';
  return 'gt10s';
}

/** 'HH' (00–23) of an instant in JST. */
export const jstHour = (now: number): string => pad(jstParts(now).h);

/** Whole weeks from the JST week of `from` to the JST week of `to` (both are Mondays after jstWeekStart). */
export function weeksBetween(from: number, to: number): number {
  const monday = (ms: number) => Date.parse(`${jstWeekStart(ms)}T00:00:00Z`);
  return Math.round((monday(to) - monday(from)) / (7 * DAY_MS));
}

/** Weeks after signup that the retention report shows. */
export const RETENTION_OFFSETS = [1, 2, 4] as const;

/** A day counter: metric plus a fixed-vocabulary dimension (never user-provided text). */
export interface DayCount {
  metric: string;
  dim: string;
}

const tag = (s: string | undefined, fallback: string): string =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 40) || fallback;

type RenewalStatus = 'renewed' | 'kept' | 'failed' | 'skipped';

/** Counters of one credential refresh: renewed / kept, or the failure reason. Skips are not renewal attempts. */
export function renewalCounts(outcome: { status: RenewalStatus; reason?: string }): DayCount[] {
  if (outcome.status === 'renewed') return [{ metric: 'renew_renewed', dim: '' }];
  if (outcome.status === 'kept') return [{ metric: 'renew_kept', dim: '' }];
  if (outcome.status === 'failed') return [{ metric: 'renew_failed', dim: tag(outcome.reason, 'error') }];
  return [];
}
