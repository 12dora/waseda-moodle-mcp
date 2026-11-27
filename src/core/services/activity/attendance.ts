/**
 * Attendance detail. Web-service channel: the mobile view (tool_mobile_get_content / mobile_view_activity); web
 * channel: the activity page (attendance-web.ts). This site has no mod_attendance_* WS and no self check-in control:
 * read-only summary + sessions (ws: the nearby ones; web: the whole term).
 */

import type { MoodleApi } from '../../context';
import { htmlToMarkdown, htmlToText, tagAttr } from '../../html';
import type { AttendanceDetail, AttendanceSession, AttendanceSummary } from '../../types';
import { type ActivityInfo, type CourseModuleInfo, pickLang, templateHtml } from '../shared';
import { countOrNull, parseSessionTime, splitStatus, textOrNull } from './attendance-text';
import { loadAttendancePage } from './attendance-web';

/** Scan budget: sessions are read from a tail window when the template exceeds this. */
export const MAX_ATTENDANCE_HTML = 80_000;
const MAX_SESSIONS = 20;
const MAX_SESSION_INNER = 2_000;
const MAX_TIME = 120;
const MAX_LABEL = 120;
const MAX_REMARKS = 200;
const MAX_CELL = 48;
const SUMMARY_AFTER = 800;

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
    points: null, // the mobile view shows no points per session
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

async function loadAttendanceTemplate(
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

/** The channel's source: the mobile template (ws) or the activity page (web). */
export function loadAttendance(api: MoodleApi, cm: CourseModuleInfo, info: ActivityInfo): Promise<AttendanceDetail> {
  return api.channel === 'web' ? loadAttendancePage(api, cm, info) : loadAttendanceTemplate(api, cm, info);
}
