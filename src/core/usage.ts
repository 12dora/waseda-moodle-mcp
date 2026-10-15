/** Usage-statistics vocabulary shared by the recorder (write path) and the operator report: JST periods and client labels. Pure. */

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
