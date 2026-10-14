/** Grade overview (all courses) and the per-course grade item report. */

import type { MoodleApi, ServiceContext } from '../context';
import { MoodleError } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import { fromTs } from '../time';
import type { CourseGrade, CourseGrades, GradeItem } from '../types';
import { listAllCourses } from './courses';
import { cleanDisplay } from './grade-format';
import { collectActivityGrades } from './grades-activity';
import { optionalPositiveInt } from './validate';

const OVERVIEW_FN = 'gradereport_overview_get_course_grades';
const ITEMS_FN = 'gradereport_user_get_grade_items';

export const GRADEBOOK_HIDDEN_HINT =
  'Waseda Moodle hides the course grade report. Pass course_id to collect assignment and quiz grades.';

interface RawOverviewGrade {
  courseid?: number;
  grade?: string | null;
  rawgrade?: string | number | null;
}

interface RawGradeItem {
  itemname?: string | null;
  itemtype?: string;
  itemmodule?: string | null;
  cmid?: number | null;
  gradeformatted?: string | null;
  rangeformatted?: string | null;
  grademin?: number | null;
  grademax?: number | null;
  percentageformatted?: string | null;
  weightformatted?: string | null;
  feedback?: string | null;
  gradedategraded?: number | null;
  gradedatesubmitted?: number | null;
}

export function mapCourseGrade(raw: RawOverviewGrade, names: ReadonlyMap<number, string>): CourseGrade {
  const courseId = Number(raw.courseid ?? 0);
  const rawGrade =
    raw.rawgrade === null || raw.rawgrade === undefined || raw.rawgrade === '' ? NaN : Number(raw.rawgrade);
  return {
    courseId,
    courseName: names.get(courseId) ?? `Course ${courseId}`,
    grade: cleanDisplay(raw.grade),
    raw: Number.isFinite(rawGrade) ? rawGrade : null,
  };
}

function itemName(raw: RawGradeItem): string {
  const n = raw.itemname ? decodeEntities(raw.itemname).trim() : '';
  if (n) return n;
  if (raw.itemtype === 'course') return 'Course total';
  if (raw.itemtype === 'category') return 'Category total';
  return '(unnamed)';
}

export function mapGradeItem(raw: RawGradeItem): GradeItem {
  const hasRange = typeof raw.grademin === 'number' && typeof raw.grademax === 'number';
  const feedback = raw.feedback ? htmlToMarkdown(raw.feedback) : '';
  return {
    name: itemName(raw),
    itemType: raw.itemtype ?? '',
    modname: raw.itemmodule || null,
    cmid: raw.cmid || null,
    grade: cleanDisplay(raw.gradeformatted),
    range: cleanDisplay(raw.rangeformatted) ?? (hasRange ? `${raw.grademin}–${raw.grademax}` : null),
    percentage: cleanDisplay(raw.percentageformatted),
    feedback: feedback || null,
    weight: cleanDisplay(raw.weightformatted),
    gradedAt: fromTs(raw.gradedategraded || raw.gradedatesubmitted),
  };
}

/** Skips category aggregates that carry no grade; the course total goes last. */
export function mapGradeItems(raw: RawGradeItem[] | null | undefined): GradeItem[] {
  const items: GradeItem[] = [];
  const totals: GradeItem[] = [];
  for (const r of raw ?? []) {
    const item = mapGradeItem(r);
    if (item.itemType === 'course') totals.push(item);
    else if (item.itemType === 'category' && item.grade === null) continue;
    else items.push(item);
  }
  return [...items, ...totals];
}

const NO_PERMISSION = /^nopermission/; // nopermissions, nopermission, nopermissiontoviewgrades

const GRADEBOOK_HIDDEN_COURSE_NOTE =
  'Waseda Moodle hides the gradebook; grades were collected from assignment feedback and quiz results.';

export type GradesResult = { overview: CourseGrade[]; note?: string } | { course: CourseGrades; note?: string };

/** null when Moodle denies the call (the gradebook is hidden); other errors propagate. */
async function orNoPermission<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof MoodleError && NO_PERMISSION.test(e.errorcode)) return null;
    throw e;
  }
}

async function overviewGrades(ctx: ServiceContext, api: MoodleApi): Promise<GradesResult> {
  const res = await orNoPermission(
    api.call<{ grades?: RawOverviewGrade[] }>(OVERVIEW_FN, { userid: api.moodleUserId }),
  );
  const grades = res?.grades ?? [];
  if (grades.length === 0) return { overview: [], note: GRADEBOOK_HIDDEN_HINT };
  const names = new Map((await listAllCourses(ctx)).map((c) => [c.id, c.name] as const));
  return { overview: grades.map((g) => mapCourseGrade(g, names)) };
}

async function courseGrades(ctx: ServiceContext, api: MoodleApi, courseId: number): Promise<GradesResult> {
  const coursesP = listAllCourses(ctx);
  coursesP.catch(() => undefined); // avoid an unhandled rejection if the items call fails first
  const res = await orNoPermission(
    api.call<{ usergrades?: Array<{ gradeitems?: RawGradeItem[] }> }>(ITEMS_FN, {
      courseid: courseId,
      userid: api.moodleUserId,
    }),
  );
  const collected = res === null ? await collectActivityGrades(api, courseId) : null;
  const courseName = (await coursesP).find((c) => c.id === courseId)?.name ?? `Course ${courseId}`;

  if (collected === null) {
    return { course: { courseId, courseName, items: mapGradeItems(res?.usergrades?.[0]?.gradeitems) } };
  }
  const unchecked = collected.unchecked > 0 ? ` (${collected.unchecked} items not checked)` : '';
  return {
    course: { courseId, courseName, items: collected.items },
    note: `${GRADEBOOK_HIDDEN_COURSE_NOTE}${unchecked}`,
  };
}

export async function getGrades(ctx: ServiceContext, opts: { courseId?: number } = {}): Promise<GradesResult> {
  const courseId = optionalPositiveInt(opts.courseId, 'course_id');
  const api = await ctx.moodle();
  return courseId === undefined ? overviewGrades(ctx, api) : courseGrades(ctx, api, courseId);
}
