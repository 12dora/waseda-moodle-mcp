/**
 * Web-channel emulation of the two grade report functions. A course that hides its report answers with a
 * no-permission page, which the session turns into MoodleError 'nopermissions' (the grade service then collects the
 * activity grades instead).
 */

import { MoodleError } from '../../../errors';
import { parseOverviewGrades, parseUserReport } from '../parse/grades';
import type { WebFunctions, WebSession } from '../types';

/** The overview of the session's own user (the only one the grade service asks for). */
async function courseGrades(web: WebSession) {
  const page = await web.page('/grade/report/overview/index.php');
  return { grades: parseOverviewGrades(page.html), warnings: [] };
}

async function gradeItems(web: WebSession, params: Record<string, unknown>) {
  const courseid = Number(params.courseid);
  const userid = Number(params.userid) || web.moodleUserId;
  const page = await web.page(`/course/user.php?mode=grade&id=${courseid}&user=${userid}`);
  const gradeitems = parseUserReport(page.html);
  if (!gradeitems) throw new MoodleError('The grade report page could not be read.', 'unreadablepage');
  return { usergrades: [{ courseid, userid, gradeitems }], warnings: [] };
}

export const gradeFunctions: WebFunctions = {
  gradereport_overview_get_course_grades: courseGrades,
  gradereport_user_get_grade_items: gradeItems,
};
