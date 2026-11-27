/**
 * Attendance on the web channel: `/mod/attendance/view.php?id=<cmid>` (the student's own view, default period).
 * Read by structure, not labels: the sessions table's cells carry the plugin's column classes (datecol, desccol,
 * statuscol, remarkscol); the summary table (`table.attlist`) lists its rows in a fixed order
 * (mod_attendance construct_user_data_stat): taken sessions, their points, their percentage, and with the "all"
 * period also all sessions, their points and percentage, the maximum possible points and percentage.
 */

import type { MoodleApi } from '../../context';
import { htmlToMarkdown } from '../../html';
import { findAll, findFirst, mainRegion, text } from '../../moodle/web/html';
import type { AttendanceDetail, AttendanceSession, AttendanceSummary } from '../../types';
import { type ActivityInfo, type CourseModuleInfo, pickLang } from '../shared';
import { countOrNull, parseSessionTime, splitStatus, textOrNull } from './attendance-text';
import { webSessionOf } from './web';

const MAX_SESSIONS = 20;
const MAX_TIME = 120;
const MAX_LABEL = 120;
const MAX_REMARKS = 200;
const MAX_CELL = 48;

/** The `<tr>` chunks of a table (rows carry no attribute to find them by). */
const rowsOf = (tableHtml: string): string[] => tableHtml.split(/<tr(?=[\s>])/i).slice(1);

const cell = (row: string, cls: string, max: number): string => {
  const el = findFirst(row, { attr: 'class', value: cls, word: true, tag: 'td' });
  return el ? text(el.inner).slice(0, max) : '';
};

function sessionOf(row: string): AttendanceSession | null {
  const time = cell(row, 'datecol', MAX_TIME);
  if (!time) return null;
  // "?" = not taken yet
  const shown = cell(row, 'statuscol', MAX_LABEL);
  const { acronym, status } = splitStatus(shown === '?' ? '' : shown);
  return {
    at: parseSessionTime(time),
    time,
    group: textOrNull(cell(row, 'desccol', MAX_LABEL)),
    acronym,
    status,
    remarks: textOrNull(cell(row, 'remarkscol', MAX_REMARKS)),
  };
}

/** Oldest first on the page; the detail lists the newest MAX_SESSIONS first. */
function parseSessions(region: string): AttendanceSession[] {
  const table = findFirst(region, { attr: 'class', value: 'attwidth', word: true, tag: 'table' });
  if (!table) return [];
  const body = table.inner.slice(Math.max(0, table.inner.search(/<tbody/i)));
  const sessions = rowsOf(body)
    .map(sessionOf)
    .filter((s): s is AttendanceSession => s !== null);
  return sessions.reverse().slice(0, MAX_SESSIONS);
}

const EMPTY_SUMMARY: AttendanceSummary = {
  takenSessions: null,
  points: null,
  percentage: null,
  totalSessions: null,
  maxPossiblePoints: null,
  maxPossiblePercentage: null,
};

/** The value cells of the summary table, in row order. */
function summaryValues(region: string): string[] {
  const table = findFirst(region, { attr: 'class', value: 'attlist', word: true, tag: 'table' });
  if (!table) return [];
  return rowsOf(table.inner).map((row) => {
    const cells = findAll(row, { attr: 'class', tag: 'td' });
    return cells.length >= 2 ? text(cells[cells.length - 1]?.inner ?? '').slice(0, MAX_CELL) : '';
  });
}

function parseSummary(region: string): AttendanceSummary {
  const v = summaryValues(region);
  if (v.length < 3) return EMPTY_SUMMARY;
  // rows 4-6 (all sessions, their points and percentage) exist only together with the maximum rows 7-8
  const all = v.length >= 8;
  return {
    takenSessions: countOrNull(v[0] ?? ''),
    points: textOrNull(v[1] ?? ''),
    percentage: textOrNull(v[2] ?? ''),
    totalSessions: all ? countOrNull(v[3] ?? '') : null,
    maxPossiblePoints: all ? textOrNull(v[6] ?? '') : null,
    maxPossiblePercentage: all ? textOrNull(v[7] ?? '') : null,
  };
}

export function parseAttendancePage(html: string, cm: CourseModuleInfo, info: ActivityInfo): AttendanceDetail {
  const region = mainRegion(html);
  const intro = findFirst(region, { attr: 'id', value: 'intro' });
  return {
    type: 'attendance',
    cmid: cm.cmid,
    instanceId: cm.instance,
    courseId: cm.courseId,
    courseName: info.courseName,
    name: cm.name,
    url: info.url,
    description: htmlToMarkdown(pickLang(intro?.inner ?? '', info.lang), { maxChars: 6000 }),
    summary: parseSummary(region),
    sessions: parseSessions(region),
    complete: true,
  };
}

export async function loadAttendancePage(
  api: MoodleApi,
  cm: CourseModuleInfo,
  info: ActivityInfo,
): Promise<AttendanceDetail> {
  const page = await webSessionOf(api).page(`/mod/attendance/view.php?id=${cm.cmid}`);
  return parseAttendancePage(page.html, cm, info);
}
