/**
 * Display helpers for the ISO JST strings the API returns. Waseda is UTC+9 without DST, so we use a fixed
 * offset (same approach as src/core/time.ts). A deadline at exactly 00:00:00 JST is shown as the previous day
 * 24:00 (matching `fmt` in src/core/time.ts); every other timestamp is formatted as is.
 */

export type Lang = 'ja' | 'en' | 'zh-CN';

const OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86_400_000;

const WEEKDAYS: Record<Lang, readonly string[]> = {
  ja: ['日', '月', '火', '水', '木', '金', '土'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  'zh-CN': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
};
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  wd: number;
}

function parts(ms: number): Parts {
  const d = new Date(ms + OFFSET_MS);
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

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function isMidnightMs(ms: number): boolean {
  const p = parts(ms);
  return p.h === 0 && p.mi === 0 && p.s === 0;
}

function datePart(p: Parts, lang: Lang, withYear: boolean): string {
  const wd = WEEKDAYS[lang][p.wd];
  if (lang === 'ja') return `${withYear ? `${p.y}年` : ''}${p.mo}月${p.d}日(${wd})`;
  if (lang === 'zh-CN') return `${withYear ? `${p.y}年` : ''}${p.mo}月${p.d}日 ${wd}`;
  return `${wd}, ${EN_MONTHS[p.mo - 1]} ${p.d}${withYear ? `, ${p.y}` : ''}`;
}

interface FormatOptions {
  /** Reference time for omitting the current year; default Date.now(). */
  now?: number;
  /** Deadline semantics: 00:00:00 is shown as the previous day 24:00. */
  deadline?: boolean;
}

/** '10月15日(水) 23:59' / 'Wed, Oct 15, 23:59' / '10月15日 周三 23:59'; year added when not the current year. */
export function formatDateTime(iso: string | null | undefined, lang: Lang, opts: FormatOptions = {}): string {
  const ms = parse(iso);
  if (ms === null) return '-';
  const asEndOfDay = opts.deadline === true && isMidnightMs(ms);
  const p = parts(asEndOfDay ? ms - DAY_MS : ms);
  const time = asEndOfDay ? '24:00' : `${pad(p.h)}:${pad(p.mi)}`;
  const withYear = p.y !== parts(opts.now ?? Date.now()).y;
  return `${datePart(p, lang, withYear)}${lang === 'en' ? ',' : ''} ${time}`;
}

/** Date only, always with the year: '2026年10月15日(水)' / 'Wed, Oct 15, 2026'. */
export function formatDate(iso: string | null | undefined, lang: Lang): string {
  const ms = parse(iso);
  if (ms === null) return '-';
  return datePart(parts(ms), lang, true);
}

export type DueGroup = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later';

/**
 * Bucket for the deadlines list. 'week' = within the next 7 calendar days (JST). A deadline at 00:00:00 belongs
 * to the previous day; pass `deadline: false` for opening times.
 */
export function dueGroup(iso: string | null | undefined, opts: FormatOptions = {}): DueGroup {
  const ms = parse(iso);
  if (ms === null) return 'later';
  const now = opts.now ?? Date.now();
  if (ms < now) return 'overdue';
  const shift = opts.deadline !== false && isMidnightMs(ms) ? 1 : 0;
  const diff = Math.floor((ms - shift + OFFSET_MS) / DAY_MS) - Math.floor((now + OFFSET_MS) / DAY_MS);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff < 7) return 'week';
  return 'later';
}

export const DUE_GROUPS: readonly DueGroup[] = ['overdue', 'today', 'tomorrow', 'week', 'later'];
