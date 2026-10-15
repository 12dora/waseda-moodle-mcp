/** Pure helpers for the operator usage page (range parsing, chart scaling, number formatting). */

import type { UsageStats } from '../api/types';
import type { Lang } from './time';

export const STATS_RANGES = [7, 30, 90] as const;
export type StatsRange = (typeof STATS_RANGES)[number];
export const DEFAULT_STATS_RANGE: StatsRange = 30;

/** `?days=` value → a supported range; anything else falls back to the default. */
export function parseStatsRange(value: string | null | undefined): StatsRange {
  return value && /^(7|30|90)$/.test(value) ? (Number(value) as StatsRange) : DEFAULT_STATS_RANGE;
}

export interface ChartScale {
  /** Top of the y axis (a round number ≥ the peak). */
  max: number;
  /** Gridline values from 0 (baseline) to `max`, ascending. */
  ticks: number[];
}

/** Round integer y axis with at most `maxTicks` steps above the baseline (1 / 2 / 5 × 10^n steps). */
export function niceScale(peak: number, maxTicks = 4): ChartScale {
  const top = Math.max(0, peak);
  if (top === 0) return { max: maxTicks, ticks: Array.from({ length: maxTicks + 1 }, (_, i) => i) };
  const raw = top / maxTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = [1, 2, 5].find((n) => norm <= n) ?? 10;
  const step = Math.max(1, nice * mag);
  const steps = Math.ceil(top / step);
  return { max: steps * step, ticks: Array.from({ length: steps + 1 }, (_, i) => i * step) };
}

/** Sparse x labels: first, middle and last index (deduplicated, ascending). */
export function xTickIndexes(count: number): number[] {
  if (count <= 0) return [];
  return [...new Set([0, Math.floor((count - 1) / 2), count - 1])];
}

/** 'YYYY-MM-DD' → 'M/D'. */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  return m && d ? `${Number(m)}/${Number(d)}` : day;
}

/** Bar / meter length in percent of `max` (0–100). */
export function sharePercent(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}

/** Failed ÷ calls, or null when there were no calls. */
export function failureRate(calls: number, errors: number): number | null {
  return calls > 0 ? errors / calls : null;
}

/** One-decimal percent ('0.9%'); '—' when there is no rate. */
export function formatRate(rate: number | null, lang: Lang): string {
  if (rate === null) return '—';
  return new Intl.NumberFormat(lang, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
    rate,
  );
}

export function peakOf(values: readonly number[]): number {
  return values.reduce((a, b) => Math.max(a, b), 0);
}

export function sumOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** False until any tool call was recorded in the range (user counts alone do not make usage). */
export function hasUsage(stats: UsageStats): boolean {
  if (stats.daily.some((d) => d.active || d.calls)) return true;
  return stats.tools.some((t) => t.calls) || stats.clients.some((c) => c.calls || c.activeMonth);
}

export interface BarSlots {
  /** Horizontal space per day. */
  slot: number;
  /** Bar width inside the slot (slot minus the gap). */
  bar: number;
}

/** Per-day slot and bar width: 2px gaps, shrinking to 1px / none when the bars get too thin to read. */
export function barSlots(count: number, plotWidth: number): BarSlots {
  if (count <= 0 || plotWidth <= 0) return { slot: 0, bar: 0 };
  const slot = plotWidth / count;
  let gap = 0;
  if (slot >= 6) gap = 2;
  else if (slot >= 3) gap = 1;
  return { slot, bar: Math.max(slot - gap, 0.5) };
}

const BAR_RADIUS = 4;

/** SVG path of a bar standing on the baseline, top corners rounded by up to 4px. */
export function barPath(x: number, baseline: number, width: number, height: number): string {
  if (width <= 0 || height <= 0) return '';
  const r = Math.min(BAR_RADIUS, width / 2, height);
  const top = baseline - height;
  const f = (n: number) => Number(n.toFixed(2));
  return [
    `M${f(x)} ${f(baseline)}`,
    `V${f(top + r)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(top)}`,
    `H${f(x + width - r)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + width)} ${f(top + r)}`,
    `V${f(baseline)}`,
    'Z',
  ].join(' ');
}
