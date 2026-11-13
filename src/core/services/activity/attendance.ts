/**
 * Attendance detail from the mobile view (tool_mobile_get_content / mobile_view_activity).
 * This site has no mod_attendance_* WS and no self check-in control: read-only summary + nearby sessions.
 */

import type { MoodleApi } from '../../context';
import { htmlToMarkdown, htmlToText, tagAttr } from '../../html';
import { isObj } from '../../moodle/wire';
import { isoJst } from '../../time';
import type { AttendanceDetail, AttendanceSession, AttendanceSummary, IsoJst } from '../../types';
import { type ActivityInfo, type CourseModuleInfo, pickLang } from '../shared';

/** Scan budget: sessions are read from a tail window when the template exceeds this. */
export const MAX_ATTENDANCE_HTML = 80_000;
const MAX_SESSIONS = 20;
const MAX_SESSION_INNER = 2_000;
const MAX_TIME = 120;
const MAX_LABEL = 120;
const MAX_REMARKS = 200;
const MAX_CELL = 48;
const SUMMARY_AFTER = 800;
const JST_OFFSET_MS = 9 * 3_600_000;

const INFO_TAG = /<core-course-module-info\b([^>]*)>/i;
const ITEM = /<ion-item\b([^>]*)>([\s\S]*?)<\/ion-item>/gi;
const H2 = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i;
const H3 = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
const NEXT_COL = /<ion-col\b[^>]*>([\s\S]*?)<\/ion-col>/i;

const SUMMARY_KEYS = [
  'sessionscompleted',
  'pointssessionscompleted',
  'percentagesessionscompleted',
  'sessionstotal',
  'maxpossiblepoints',
  'maxpossiblepercentage',
] as const;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = MONTHS.join('|');
const CLOCK = '(?<h>\\d{1,2}):(?<mi>\\d{2})\\s*(?<mer>[ap])?\\.?m?';
const WD = '(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*';
/** `2026年 10月 13日(月曜日) 13:00` */
const JA_DATE = /(?<y>\d{4})\s*年\s*(?<mo>\d{1,2})\s*月\s*(?<d>\d{1,2})\s*日\D*?(?<h>\d{1,2}):(?<mi>\d{2})/;
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
  for (const re of [JA_DATE, EN_DMY, EN_DAY_FIRST, EN_MONTH_FIRST]) {
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

function templateHtml(content: unknown): string {
  if (!isObj(content) || !Array.isArray(content.templates)) return '';
  return content.templates.map((t) => (isObj(t) && typeof t.html === 'string' ? t.html : '')).join('\n');
}

function countOrNull(s: string): number | null {
  const t = s.trim();
  if (!t || t.includes('/') || t.includes('%')) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function textOrNull(s: string): string | null {
  const t = s.trim();
  return t ? t : null;
}

/** Tags off, whitespace collapsed, then a hard length cap (cell values and session labels). */
function boundedText(html: string, max: number): string {
  if (!html) return '';
  const src = html.length > max * 2 ? html.slice(0, max * 2) : html;
  const t = htmlToText(src);
  return t.length <= max ? t : t.slice(0, max);
}

/** Value of one `plugin.mod_attendance.<key>` row; looks up the key itself, not a document prefix. */
function valueAfterKey(html: string, key: string): string {
  const needle = `'plugin.mod_attendance.${key}'`;
  const i = html.lastIndexOf(needle);
  if (i < 0) return '';
  const from = i + needle.length;
  const col = NEXT_COL.exec(html.slice(from, from + SUMMARY_AFTER));
  return col ? boundedText(col[1] ?? '', MAX_CELL) : '';
}

/** Values keyed by `plugin.mod_attendance.*` (the translate keys, not the localised labels). */
function parseSummary(html: string): AttendanceSummary {
  const values: Record<string, string> = {};
  for (const key of SUMMARY_KEYS) {
    const v = valueAfterKey(html, key);
    if (v) values[key] = v;
  }
  const taken = values.sessionscompleted;
  const points = values.pointssessionscompleted;
  const percentage = values.percentagesessionscompleted;
  const total = values.sessionstotal;
  const maxPoints = values.maxpossiblepoints;
  const maxPct = values.maxpossiblepercentage;
  return {
    takenSessions: taken ? countOrNull(taken) : null,
    points: points ? textOrNull(points) : null,
    percentage: percentage ? textOrNull(percentage) : null,
    totalSessions: total ? countOrNull(total) : null,
    maxPossiblePoints: maxPoints ? textOrNull(maxPoints) : null,
    maxPossiblePercentage: maxPct ? textOrNull(maxPct) : null,
  };
}

function splitStatus(text: string): { acronym: string | null; status: string | null } {
  const t = text.trim();
  if (!t) return { acronym: null, status: null };
  const pair = /^([A-Z]{1,3})\s*[–—:-]\s+(.+)$/.exec(t);
  if (pair?.[1] && pair[2]) return { acronym: pair[1], status: pair[2].trim() };
  if (/^[A-Z]{1,3}$/.test(t)) return { acronym: t, status: t };
  return { acronym: null, status: t };
}

function parseSession(inner: string): AttendanceSession | null {
  const timeHtml = H2.exec(inner)?.[1];
  if (timeHtml === undefined) return null;
  const time = boundedText(timeHtml, MAX_TIME);
  if (!time) return null;
  const h3s: string[] = [];
  H3.lastIndex = 0;
  for (let m = H3.exec(inner); m; m = H3.exec(inner)) {
    const max = h3s.length >= 2 ? MAX_REMARKS : MAX_LABEL;
    h3s.push(boundedText(m[1] ?? '', max));
  }
  const group = textOrNull(h3s[0] ?? '');
  const { acronym, status } = splitStatus(h3s[1] ?? '');
  return {
    at: parseSessionTime(time),
    time,
    group,
    acronym,
    status,
    remarks: textOrNull(h3s[2] ?? ''),
  };
}

/**
 * Oldest-first in the template. Keep a rolling last-N so the result is the newest N
 * of the region (the document end, or a tail window that includes it).
 */
function parseSessions(html: string): AttendanceSession[] {
  const keep: AttendanceSession[] = [];
  ITEM.lastIndex = 0;
  for (let m = ITEM.exec(html); m; m = ITEM.exec(html)) {
    const attrs = m[1] ?? '';
    const inner = (m[2] ?? '').slice(0, MAX_SESSION_INNER);
    if (/ion-grid/i.test(inner) || /\bmessages\b/i.test(attrs) || /class="messages"/i.test(inner)) continue;
    const sess = parseSession(inner);
    if (!sess) continue;
    if (keep.length === MAX_SESSIONS) keep.shift();
    keep.push(sess);
  }
  keep.reverse();
  return keep;
}

/** Newest sessions sit just before the summary; a tail window preserves them when the page is huge. */
function sessionRegion(html: string): string {
  if (html.length <= MAX_ATTENDANCE_HTML) return html;
  const tail = html.slice(-MAX_ATTENDANCE_HTML);
  const at = tail.indexOf('<ion-item');
  return at >= 0 ? tail.slice(at) : tail;
}

function parseDescription(html: string, lang?: string | null): string {
  const region = html.length > MAX_ATTENDANCE_HTML ? html.slice(0, MAX_ATTENDANCE_HTML) : html;
  const attrs = INFO_TAG.exec(region)?.[1] ?? '';
  const intro = tagAttr(attrs, 'description');
  return htmlToMarkdown(pickLang(intro, lang), { maxChars: 6000 });
}

export function mapAttendance(html: string, cm: CourseModuleInfo, info: ActivityInfo): AttendanceDetail {
  const complete = html.length <= MAX_ATTENDANCE_HTML;
  return {
    type: 'attendance',
    cmid: cm.cmid,
    instanceId: cm.instance,
    courseId: cm.courseId,
    courseName: info.courseName,
    name: cm.name,
    url: info.url,
    description: parseDescription(html, info.lang),
    summary: parseSummary(html),
    sessions: parseSessions(sessionRegion(html)),
    complete,
  };
}

export async function loadAttendance(
  api: MoodleApi,
  cm: CourseModuleInfo,
  info: ActivityInfo,
): Promise<AttendanceDetail> {
  const content = await api.call('tool_mobile_get_content', {
    component: 'mod_attendance',
    method: 'mobile_view_activity',
    args: [
      { name: 'cmid', value: String(cm.cmid) },
      { name: 'courseid', value: String(cm.courseId) },
    ],
  });
  return mapAttendance(templateHtml(content), cm, info);
}
