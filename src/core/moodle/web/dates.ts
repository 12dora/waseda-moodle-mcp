/**
 * Dates as Moodle pages print them in the user's language, read back to unix seconds (Asia/Tokyo, no DST).
 * Prefer machine values when a page has them (`data-timestamp`, `data-mdl-overview-value`); these parsers are for
 * the text-only places (activity dates, attempt tables, submission status).
 *   ja / zh: `2026年 10月 8日(木曜日) 23:59`, `2026年 10月 8日, 23:59`, `2026年10月8日 星期四 23:59`
 *   en:      `Thursday, 8 October 2026, 11:59 PM`, `8 October 2026, 11:59 PM`, `8/10/26, 23:59`-style is not read
 * Unrecognised text gives null (callers keep the text).
 */

const JST_OFFSET_SEC = 9 * 3600;
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const CJK = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日[^\d]{0,24}?(\d{1,2})[:：](\d{2})/;
const EN = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/;

function toUnix(parts: { y: number; mo: number; d: number; h: number; mi: number }): number | null {
  const { y, mo, d, h, mi } = parts;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const sec = Date.UTC(y, mo - 1, d, h, mi) / 1000 - JST_OFFSET_SEC;
  return Number.isFinite(sec) ? sec : null;
}

function hour12(h: number, meridiem: string | undefined): number {
  if (!meridiem) return h;
  const pm = meridiem.toLowerCase() === 'pm';
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

function parseCjk(s: string): number | null {
  const m = CJK.exec(s);
  if (!m) return null;
  return toUnix({ y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]) });
}

function parseEn(s: string): number | null {
  const m = EN.exec(s);
  if (!m) return null;
  const mo = MONTHS.indexOf((m[2] ?? '').toLowerCase()) + 1;
  if (mo === 0) return null;
  const h = hour12(Number(m[4]), m[6]);
  return toUnix({ y: Number(m[3]), mo, d: Number(m[1]), h, mi: Number(m[5]) });
}

/** The first date-time in `text` (unix seconds), or null. Full-width digits are normalised first. */
export function parseMoodleDate(text: string): number | null {
  const s = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return parseCjk(s) ?? parseEn(s);
}
