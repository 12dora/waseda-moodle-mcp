/**
 * Time helpers. Waseda Moodle users live in Asia/Tokyo (UTC+9, no DST), so we format with a fixed
 * offset instead of Intl time zones (cheaper on Workers CPU and identical results).
 */

import type { IsoJst } from './types';

const JST_OFFSET_MS = 9 * 3600 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const pad = (n: number) => String(n).padStart(2, '0');

export interface JstParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** Day of week, 0 = Sunday. */
  wd: number;
}

/** Wall-clock parts of an instant in JST (shifted Date whose UTC getters read JST values). */
export function jstParts(ms: number): JstParts {
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    wd: d.getUTCDay(),
  };
}

export function nowMs(): number {
  return Date.now();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Unix ms -> '2026-10-15T23:59:00+09:00'. */
export function isoJst(ms: number): IsoJst {
  const p = jstParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}+09:00`;
}

/** Moodle unix seconds -> ISO JST; 0/null/undefined (Moodle's "unset") -> null. */
export function fromTs(ts: number | null | undefined): IsoJst | null {
  if (!ts) return null;
  return isoJst(ts * 1000);
}

export function toMs(iso: IsoJst): number {
  return Date.parse(iso);
}

/** True when the instant is exactly 00:00 JST — students read it as the previous day 24:00. */
export function isMidnight(ts: number | null | undefined): boolean {
  if (!ts) return false;
  const p = jstParts(ts * 1000);
  return p.h === 0 && p.mi === 0;
}

const isMidnightMs = (ms: number) => {
  const p = jstParts(ms);
  return p.h === 0 && p.mi === 0;
};

/** Compact display for tool text: '2026-10-15 Wed 23:59' (00:00 stays 00:00). Use fmtDue for deadlines. */
export function fmt(iso: IsoJst | null | undefined): string {
  if (!iso) return '-';
  const p = jstParts(Date.parse(iso));
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${WEEKDAYS[p.wd]} ${pad(p.h)}:${pad(p.mi)}`;
}

/** Deadline display: exactly 00:00 reads as the previous day 24:00 ('2026-10-14 Wed 24:00'). */
export function fmtDue(iso: IsoJst | null | undefined): string {
  if (!iso) return '-';
  const ms = Date.parse(iso);
  if (!isMidnightMs(ms)) return fmt(iso);
  const q = jstParts(ms - 86_400_000);
  return `${q.y}-${pad(q.mo)}-${pad(q.d)} ${WEEKDAYS[q.wd]} 24:00`;
}

/** The instant a deadline "feels like" (what fmtDue shows): midnight counts as the last millisecond of the day before. */
export function deadlineMs(iso: IsoJst): number {
  const ms = Date.parse(iso);
  return isMidnightMs(ms) ? ms - 1 : ms;
}
