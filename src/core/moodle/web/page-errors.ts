/**
 * Moodle error pages (print_error / moodle_exception rendered as HTML): `<div data-rel="fatalerror" class="box …
 * errorbox …"><p class="errormessage">…</p><p class="errorcode"><a href="…/error/moodle/nopermissions">`.
 * The docs link carries Moodle's error code (machine value); the text is the fallback (ja and en). The error's
 * message is English for the codes we know (Moodle's text is in the session language); unknown codes keep it.
 *
 * Maintenance: Moodle answers every page with HTTP 503 and print_maintenance_message() (`<body id=
 * "page-maintenance-message"`, the admin's notice in `<div class="… maintenance_message …">`), or the static
 * climaintenance.html during CLI maintenance. UNVERIFIED against Waseda (no sample): markup from Moodle's source.
 */

import { MoodleError, MoodleUnavailable } from '../../errors';
import { findFirst, text } from './html';

const MARKERS = ['data-rel="fatalerror"', 'class="box errorbox', ' errorbox ', 'class="errormessage"'];

/** Moodle error codes (the docs link) -> the codes this codebase uses. */
const CODES: Readonly<Record<string, string>> = {
  nopermissions: 'nopermissions',
  accessdenied: 'nopermissions',
  invalidrecord: 'invalidrecord',
  invalidrecordunknown: 'invalidrecord',
  invalidcoursemodule: 'invalidrecord',
  invalidcourseid: 'invalidrecord',
  invalidid: 'invalidrecord',
  requireloginerror: 'requireloginerror',
  notenrolled: 'requireloginerror',
};

/** Text patterns per code, for error pages without a docs link (first match wins). */
const TEXTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/パーミッションがありません|do not currently have permissions|Sorry, but you do not/i, 'nopermissions'],
  [/データレコードが見つかりません|Can't find data record|Invalid course module ID/i, 'invalidrecord'],
  [/このコースに登録されていません|You are not enrolled|You cannot/i, 'requireloginerror'],
];

const MAX_MESSAGE = 200;

/** English messages for the codes this codebase knows (the page's own text is in the session language). */
const MESSAGES: Readonly<Record<string, string>> = {
  nopermissions: 'Moodle refused access to this page.',
  invalidrecord: 'Moodle could not find this item.',
  requireloginerror: 'Moodle says the user is not enrolled in this course, or the course is hidden.',
};

function errorCode(html: string, message: string): string {
  const linked = /\/error\/[a-z0-9_]+\/([a-z0-9_]+)"/i.exec(html)?.[1]?.toLowerCase() ?? '';
  const mapped = CODES[linked];
  if (mapped) return mapped;
  return TEXTS.find(([re]) => re.test(message))?.[1] ?? 'moodle_error';
}

function clip(s: string): string {
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s;
}

/** The MoodleError a Moodle error page stands for, or null for an ordinary page. `url`: the page that showed it. */
export function pageError(html: string, url: string | null = null): MoodleError | null {
  if (!MARKERS.some((m) => html.includes(m))) return null;
  const box =
    findFirst(html, { attr: 'data-rel', value: 'fatalerror' }) ??
    findFirst(html, { attr: 'class', value: 'errorbox', word: true });
  const scope = box?.outer ?? html;
  const msgEl = findFirst(scope, { attr: 'class', value: 'errormessage', word: true });
  if (!box && !msgEl) return null;
  const shown = clip(text(msgEl?.inner ?? box?.inner ?? '')) || 'Moodle showed an error page.';
  const code = errorCode(scope, shown);
  return new MoodleError(MESSAGES[code] ?? shown, code, '', { url });
}

// ------------------------------------------------------------------ maintenance

const MAINTENANCE_MARKERS = ['id="page-maintenance-message"', 'maintenance_message', 'climaintenance'];
const MAINTENANCE_TEXT = /under maintenance|undergoing maintenance|メンテナンス中/i;
/**
 * Dates in the notice: 2026/11/30, 2026-11-30, 2026.11.30, 2026年11月30日 (with a year, any separator) or 11/30,
 * 11月30日 (without one: '/' or 月 only, so version numbers "5.1" and phone numbers "03-5286-1234" are no dates), not
 * inside a longer run of digits and separators. Times: 6:00, 18:45. Linear, no nested quantifiers.
 */
const DATE = /(?<![\d./-])(?:\d{4}[/年.-](\d{1,2})[/月.-](\d{1,2})|(\d{1,2})[/月](\d{1,2}))日?(?![\d./-])/g;
const TIME = /(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g;

const inRange = (v: number, min: number, max: number) => v >= min && v <= max;

/** A time of day that exists (24:00 is the end of a day). */
function isTime(m: RegExpMatchArray): boolean {
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return inRange(mi, 0, 59) && (h < 24 || (h === 24 && mi === 0));
}

/** "11/30", or null when the match is no calendar date (month 1..12, day 1..31). */
function dateOf(m: RegExpMatchArray): string | null {
  const mo = Number(m[1] ?? m[3]);
  const d = Number(m[2] ?? m[4]);
  return inRange(mo, 1, 12) && inRange(d, 1, 31) ? `${mo}/${d}` : null;
}

/**
 * The end of the maintenance as the notice writes it ("11/30 06:00", "06:00"): its last time of day, with the last
 * date before it. Null when the notice has no time. Admin free text, so this is a best guess.
 */
export function maintenanceEnd(notice: string): string | null {
  const last = [...notice.matchAll(TIME)].filter(isTime).at(-1);
  if (!last || last.index === undefined) return null;
  const time = `${last[1]?.padStart(2, '0')}:${last[2]}`;
  const dates = [...notice.slice(0, last.index).matchAll(DATE)].map(dateOf).filter((d) => d !== null);
  const date = dates.at(-1);
  return date ? `${date} ${time}` : time;
}

/** The MoodleUnavailable a maintenance page stands for, or null when `html` is none. */
export function maintenanceError(html: string): MoodleUnavailable | null {
  if (!MAINTENANCE_MARKERS.some((m) => html.includes(m)) && !MAINTENANCE_TEXT.test(html)) return null;
  const box = findFirst(html, { attr: 'class', value: 'maintenance_message', word: true });
  return underMaintenance(box ? maintenanceEnd(text(box.inner)) : null);
}

/** Moodle is in maintenance mode (page or errorcode `sitemaintenance`); `until` as maintenanceEnd gives it. */
export function underMaintenance(until: string | null = null): MoodleUnavailable {
  const message = `Waseda Moodle is under maintenance${until ? ` (its notice gives ${until} JST as the end)` : ''}.`;
  return new MoodleUnavailable(message, { maintenance: true, until });
}
