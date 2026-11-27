/**
 * Times on forum pages. Moodle 4.3+ prints them with core/time_element (`<time datetime="2026-10-08T23:59+09:00">`);
 * older templates and tooltips only have text (`Thu, 8 Oct 2026, 11:59 PM`, `2026年 10月 8日(木) 23:59`).
 */

import { parseMoodleDate } from '../dates';
import { attr, findAll } from '../html';

const MONTH_ABBR: Record<string, string> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  sept: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
};
const ABBR = /\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?(?=\s+\d{4})/gi;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** A `datetime` attribute (ISO 8601) in unix seconds; no zone = Asia/Tokyo (the user's time zone on Waseda Moodle). */
function isoSeconds(value: string): number | null {
  const m = ISO.exec(value.trim());
  if (!m) return null;
  const zone = m[7] ?? '+09:00';
  const normalised = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${normalised}`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** parseMoodleDate, also for abbreviated English month names (`8 Oct 2026, 11:59 PM`). */
export function textSeconds(value: string): number | null {
  return parseMoodleDate(value.replace(ABBR, (w) => MONTH_ABBR[w.replace('.', '').toLowerCase()] ?? w));
}

/** Every `<time datetime>` in `html`, in document order (unix seconds; unreadable ones are skipped). */
export function timesIn(html: string): number[] {
  const out: number[] = [];
  for (const el of findAll(html, { attr: 'datetime', tag: 'time' })) {
    const s = isoSeconds(attr(el.attrs, 'datetime'));
    if (s !== null) out.push(s);
  }
  return out;
}
