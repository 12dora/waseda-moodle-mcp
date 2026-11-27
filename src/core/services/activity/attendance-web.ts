/**
 * Attendance on the web channel: `/mod/attendance/view.php?id=<cmid>` (the student's own view), read for the whole
 * term (`&view=5`, "all sessions"; the page opens on the period the user chose last).
 * Read by structure, not labels: the view buttons by their `view=` links; the sessions table's cells by the plugin's
 * column classes (datecol, desccol, statuscol, pointscol, remarkscol); the summary table (`table.attlist`) lists its
 * rows in a fixed order (mod_attendance construct_user_data_stat): taken sessions, their points, their percentage,
 * and with the "all" view also all sessions, their points and percentage, the maximum possible points and percentage.
 */

import type { MoodleApi } from '../../context';
import { BudgetExceeded, MoodleError, MoodleUnavailable } from '../../errors';
import { htmlToMarkdown } from '../../html';
import { findAll, findFirst, links, mainRegion, queryInt, text } from '../../moodle/web/html';
import type { WebSession } from '../../moodle/web/types';
import type { AttendanceDetail, AttendanceSession, AttendanceSummary } from '../../types';
import { type ActivityInfo, type CourseModuleInfo, pickLang } from '../shared';
import { countOrNull, parseSessionTime, splitStatus, textOrNull } from './attendance-text';
import { webSessionOf } from './web';

/** A whole term: four meetings a week for 15 weeks. */
const MAX_SESSIONS = 60;
/** The plugin's views: days, weeks, months, all past, all sessions. */
const VIEWS = [1, 2, 3, 4, 5];
const VIEW_ALL = 5;
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
    points: textOrNull(cell(row, 'pointscol', MAX_CELL)),
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

/** The view a page shows: the one its view buttons do not link to. null when the page does not tell. */
function shownView(html: string): number | null {
  const controls = findFirst(html, { attr: 'class', value: 'viewcontrols', word: true });
  if (!controls) return null;
  const offered = new Set(links(controls.inner).map((href) => queryInt(href, 'view')));
  const missing = VIEWS.filter((view) => !offered.has(view));
  return missing.length === 1 ? (missing[0] ?? null) : null;
}

/** `complete` = the page shows all sessions, not just one period. */
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
    complete: shownView(region) === VIEW_ALL,
  };
}

const viewPath = (cmid: number, view?: number): string =>
  `/mod/attendance/view.php?id=${cmid}${view ? `&view=${view}` : ''}`;

const isReadFailure = (e: unknown): boolean =>
  e instanceof MoodleError || e instanceof MoodleUnavailable || e instanceof BudgetExceeded;

/**
 * The page with every session of the term (at most two requests beyond the first). Moodle keeps the chosen view in the
 * user's session, so their browser would show it too: after reading "all", the view that was active before is requested
 * again. A page that does not tell which one that was is left as it is; a failed switch gives the first page; a failed
 * restore keeps what was read.
 */
async function wholeTermPage(web: WebSession, cmid: number): Promise<string> {
  const first = (await web.page(viewPath(cmid))).html;
  const previous = shownView(first);
  if (previous === null || previous === VIEW_ALL) return first;
  try {
    return (await web.page(viewPath(cmid, VIEW_ALL))).html;
  } catch (e) {
    if (!isReadFailure(e)) throw e;
    return first;
  } finally {
    // also after a failed switch: Moodle may have stored the new view before the answer was lost
    await web.page(viewPath(cmid, previous)).catch(() => undefined);
  }
}

export async function loadAttendancePage(
  api: MoodleApi,
  cm: CourseModuleInfo,
  info: ActivityInfo,
): Promise<AttendanceDetail> {
  return parseAttendancePage(await wholeTermPage(webSessionOf(api), cm.cmid), cm, info);
}
