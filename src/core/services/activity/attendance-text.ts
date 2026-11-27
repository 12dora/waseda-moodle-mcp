/** Attendance text as Moodle prints it (mobile template and activity page alike): session times, statuses, cells. */

import { isoJst } from '../../time';
import type { IsoJst } from '../../types';

const JST_OFFSET_MS = 9 * 3_600_000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = MONTHS.join('|');
const CLOCK = '(?<h>\\d{1,2}):(?<mi>\\d{2})\\s*(?<mer>[ap])?\\.?m?';
const WD = '(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*';
/** `2026年 10月 13日(月曜日) 13:00` */
const JA_DATE = /(?<y>\d{4})\s*年\s*(?<mo>\d{1,2})\s*月\s*(?<d>\d{1,2})\s*日\D*?(?<h>\d{1,2}):(?<mi>\d{2})/;
/** `2026/11/13 (金) 8:50AM` (the activity page's date column in Japanese) */
const SLASH_DATE = new RegExp(`(?<y>\\d{4})/(?<mo>\\d{1,2})/(?<d>\\d{1,2})\\D{0,12}?${CLOCK}`, 'i');
/** `Mon 13 Oct 2026 01:00PM` (mod_attendance strftimedmyw + strftimehm) */
const EN_DMY = new RegExp(`${WD}\\s+(?<d>\\d{1,2})\\s+(?<mon>${MONTH})[a-z]*\\.?\\s+(?<y>\\d{4})[,\\s]+${CLOCK}`, 'i');
/** `Monday, 13 October 2026, 1:00 PM` */
const EN_DAY_FIRST = new RegExp(
  `(?<d>\\d{1,2})(?:st|nd|rd|th)?\\s+(?<mon>${MONTH})[a-z]*\\.?\\s+(?<y>\\d{4})[,\\s]+${CLOCK}`,
  'i',
);
/** `October 13, 2026, 1:00 PM` */
const EN_MONTH_FIRST = new RegExp(
  `(?<mon>${MONTH})[a-z]*\\.?\\s+(?<d>\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?<y>\\d{4})[,\\s]+${CLOCK}`,
  'i',
);

function monthIndex(g: { mo?: string; mon?: string }): number {
  return g.mo ? Number(g.mo) : MONTHS.indexOf((g.mon ?? '').slice(0, 3).toLowerCase()) + 1;
}

function clockHour(h: number, meridiem: string | undefined): number {
  const mer = meridiem?.toLowerCase();
  if (mer === 'p') return h < 12 ? h + 12 : h;
  if (mer === 'a' && h === 12) return 0;
  return h;
}

/** Printed session start (Japanese or English) as ISO JST; null if unreadable. */
export function parseSessionTime(text: string): IsoJst | null {
  for (const re of [JA_DATE, SLASH_DATE, EN_DMY, EN_DAY_FIRST, EN_MONTH_FIRST]) {
    const g = re.exec(text)?.groups;
    if (!g) continue;
    const y = Number(g.y);
    const mo = monthIndex(g);
    const d = Number(g.d);
    const h = clockHour(Number(g.h), g.mer);
    const mi = Number(g.mi);
    if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) continue;
    return isoJst(Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS);
  }
  return null;
}

export function countOrNull(s: string): number | null {
  const t = s.trim();
  if (!t || t.includes('/') || t.includes('%')) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

export function textOrNull(s: string): string | null {
  const t = s.trim();
  return t ? t : null;
}

export function splitStatus(text: string): { acronym: string | null; status: string | null } {
  const t = text.trim();
  if (!t) return { acronym: null, status: null };
  const pair = /^([A-Z]{1,3})\s*[–—:-]\s+(.+)$/.exec(t);
  if (pair?.[1] && pair[2]) return { acronym: pair[1], status: pair[2].trim() };
  if (/^[A-Z]{1,3}$/.test(t)) return { acronym: t, status: t };
  return { acronym: null, status: t };
}
