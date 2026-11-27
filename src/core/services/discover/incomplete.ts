/**
 * list_incomplete: activities with completion tracking the user has not finished yet, per course. Pure read: the
 * course structure (`core_course_get_contents`; on the web channel the state plus ONE course page, which is also
 * where the condition texts come from) never opens an activity page, so nothing is marked viewed or done.
 */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput, MoodleError } from '../../errors';
import { decodeEntities } from '../../html';
import type { RawModule, RawSection } from '../../moodle/raw-course';
import type { Course } from '../../types';
import { mapCompleted } from '../courses';
import { webCallsLeft } from '../forums';
import { resolveScope } from '../scope';
import { optionalPositiveInt } from '../validate';
import { openConditions, pageConditions, type RawCondition } from './conditions';
import type { IncompleteActivity, IncompleteCourse, IncompleteList, SkippedCourse } from './types';

const CONTENTS_FN = 'core_course_get_contents';
/** Moodle requests one course costs on the web channel: the ajax course state and the course page. */
const WEB_COST_PER_COURSE = 2;
const MAX_KINDS = 10;

interface ContentModule extends RawModule {
  completiondata?: { state?: number; hascompletion?: boolean; details?: RawCondition[] | null } | null;
}

interface ContentSection extends RawSection {
  modules?: ContentModule[] | null;
}

interface IncompleteOptions {
  courseId?: number;
  kinds?: string[];
  includeHidden?: boolean;
}

interface Filter {
  kinds: ReadonlySet<string> | null;
  includeHidden: boolean;
}

const isHidden = (m: ContentModule) => m.uservisible === false || m.visible === 0 || m.visible === false;

function completionKind(m: ContentModule): IncompleteActivity['completion'] {
  if (m.completion === 1) return 'manual';
  return m.completion === 2 ? 'automatic' : 'unknown';
}

/** Completion of a module the filter keeps: null = not tracked (or filtered out), true = done, false = to do. */
function trackedState(m: ContentModule, filter: Filter): boolean | null {
  if (!m.modname || (filter.kinds && !filter.kinds.has(m.modname))) return null;
  if (isHidden(m) && !filter.includeHidden) return null;
  return mapCompleted(m);
}

interface CourseTally {
  done: number;
  total: number;
  activities: IncompleteActivity[];
}

function tallySection(section: ContentSection, filter: Filter, page: Map<number, string[]>, tally: CourseTally) {
  const sectionName = decodeEntities(section.name ?? '');
  for (const m of section.modules ?? []) {
    const done = trackedState(m, filter);
    if (done === null) continue;
    tally.total++;
    if (done) {
      tally.done++;
      continue;
    }
    const cmid = Number(m.id ?? 0);
    const fromService = openConditions(m.completiondata?.details);
    tally.activities.push({
      cmid,
      name: decodeEntities(m.name ?? ''),
      kind: m.modname ?? '',
      url: m.url || null,
      sectionNumber: Number(section.section ?? 0),
      sectionName,
      completion: completionKind(m),
      conditions: fromService.length > 0 ? fromService : (page.get(cmid) ?? []),
      hidden: isHidden(m),
    });
  }
}

/** The course page the web adapter already read for the structure (memoised by path, so no further request). */
async function conditionsFromPage(api: MoodleApi, courseId: number): Promise<Map<number, string[]>> {
  if (api.channel !== 'web' || !api.web) return new Map();
  try {
    return pageConditions((await api.web.page(`/course/view.php?id=${courseId}`)).html);
  } catch (e) {
    if (e instanceof MoodleError) return new Map();
    throw e;
  }
}

async function readCourse(api: MoodleApi, course: Course, filter: Filter): Promise<IncompleteCourse> {
  const raw = await api.call<ContentSection[]>(CONTENTS_FN, { courseid: course.id });
  const page = await conditionsFromPage(api, course.id);
  const tally: CourseTally = { done: 0, total: 0, activities: [] };
  for (const section of Array.isArray(raw) ? raw : []) tallySection(section, filter, page, tally);
  return { courseId: course.id, courseName: course.name, ...tally };
}

/** A course Moodle refuses or cannot show is skipped, not fatal; every other error (session, budget) stays. */
async function readOrSkip(api: MoodleApi, course: Course, filter: Filter): Promise<IncompleteCourse | SkippedCourse> {
  try {
    return await readCourse(api, course, filter);
  } catch (e) {
    if (!(e instanceof MoodleError)) throw e;
    return { courseId: course.id, courseName: course.name, reason: 'unreadable' };
  }
}

/** Which courses to read within the request budget (web: two requests each); the rest are skipped. */
function planCourses(api: MoodleApi, courses: Course[]): { read: Course[]; skipped: SkippedCourse[] } {
  const cost = api.channel === 'web' ? WEB_COST_PER_COURSE : 1;
  const room = Math.floor(webCallsLeft(api) / cost);
  const skipped = courses.slice(room).map((c) => ({ courseId: c.id, courseName: c.name, reason: 'budget' as const }));
  return { read: courses.slice(0, Math.max(0, room)), skipped };
}

async function selectCourses(ctx: ServiceContext, courseId: number | undefined): Promise<Course[]> {
  const scope = await resolveScope(ctx);
  if (courseId === undefined) return scope.courses.filter((c) => c.mine);
  const course = scope.courses.find((c) => c.id === courseId);
  if (!course) throw new InvalidInput(`Not enrolled in course ${courseId}.`);
  return [course];
}

function normaliseKinds(kinds: string[] | undefined): Set<string> | null {
  const list = [...new Set((kinds ?? []).map((k) => k.trim().toLowerCase()).filter((k) => k !== ''))];
  if (list.length > MAX_KINDS) throw new InvalidInput(`Pass at most ${MAX_KINDS} kinds.`);
  return list.length > 0 ? new Set(list) : null;
}

/**
 * Per course the activities with completion tracking that are not done. Default scope: the user's current courses
 * (course selection); `courseId` reads one enrolled course. Courses beyond the request budget are listed as skipped.
 */
export async function listIncomplete(ctx: ServiceContext, opts: IncompleteOptions = {}): Promise<IncompleteList> {
  const courseId = optionalPositiveInt(opts.courseId, 'course_id');
  const kinds = normaliseKinds(opts.kinds);
  const filter: Filter = { kinds, includeHidden: opts.includeHidden === true };
  const courses = await selectCourses(ctx, courseId);
  const api = await ctx.moodle();
  const plan = planCourses(api, courses);
  const outcomes = await Promise.all(plan.read.map((course) => readOrSkip(api, course, filter)));
  const read = outcomes.filter((o): o is IncompleteCourse => 'activities' in o);
  return {
    courses: read.filter((c) => c.total > 0),
    skippedCourses: [...plan.skipped, ...outcomes.filter((o): o is SkippedCourse => 'reason' in o)],
    kinds: kinds ? [...kinds] : null,
  };
}
