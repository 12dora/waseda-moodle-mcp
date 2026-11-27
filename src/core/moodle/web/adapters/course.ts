/**
 * Course structure on the web channel: core_course_get_contents, core_course_get_course_module(_by_instance),
 * core_completion_get_activities_completion_status, core_enrol_get_users_courses.
 *
 * Structure and ids come from the ajax `core_courseformat_get_state` (a JSON string: sections with their cm lists,
 * cms with name/module/url/visibility/completion state); what the state lacks (section summaries, descriptions,
 * activity dates, manual vs automatic completion) from ONE course page. With the `cmid` option the module's
 * `core_course_get_module` snippet replaces the page (both ajax calls share one request). Instance ids follow the
 * r14 contract: the cmid (surrogate), except forum/hsuforum whose real instance comes from the forum adapter.
 * Resources and folders carry `contents: []` (files are resolved per activity by the content adapter).
 */

import { MoodleError } from '../../../errors';
import { findFirst, pageConfig, text } from '../html';
import { type CoursePage, type PageCm, parseCmItem, parseCoursePage } from '../parse/course-page';
import type { WebFunctions, WebSession } from '../types';
import { forumInstanceOf } from './forum';

interface StateSection {
  id?: string | number;
  section?: number;
  number?: number;
  title?: string;
  visible?: boolean;
  cmlist?: Array<string | number>;
  component?: string | null;
  itemid?: number | null;
}

interface StateCm {
  id?: string | number;
  name?: string;
  module?: string;
  url?: string;
  visible?: boolean;
  uservisible?: boolean;
  completionstate?: number;
}

interface CourseState {
  section: StateSection[];
  cm: Map<number, StateCm>;
}

/** Modules whose `instance` is the real one on the web channel (ajax forum functions need it). */
const REAL_INSTANCE = new Set(['forum', 'hsuforum']);
const REDIRECTS = new Set(['resource', 'url']);
const forumTypeOf = (modname: string): 'forum' | 'hsuforum' | null =>
  modname === 'forum' || modname === 'hsuforum' ? modname : null;
const NO_FILES_ON_PAGE = new Set(['resource', 'folder']);
const MODNAME = /^[a-z][a-z0-9_]*$/;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The object entries of a JSON array (loose boundary shapes; every field optional). */
const recordsOf = <T extends object>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x): x is T => isRec(x)) : []);

function idParam(params: Record<string, unknown>, name: string): number {
  const n = Number(params[name]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new MoodleError(`Invalid parameter ${name}.`, 'invalidparameter');
  return n;
}

const sectionNumber = (s: StateSection) => Number(s.section ?? s.number ?? 0);

const notFound = () => new MoodleError('The activity was not found or is not accessible.', 'invalidrecord');

async function readState(web: WebSession, courseId: number): Promise<CourseState> {
  const raw = await web.ajax<unknown>('core_courseformat_get_state', { courseid: courseId });
  let state: unknown = raw;
  try {
    if (typeof raw === 'string') state = JSON.parse(raw);
  } catch {
    state = null;
  }
  if (!isRec(state)) throw new MoodleError('Moodle sent an unreadable course structure.', 'invalidresponse');
  const cms = recordsOf<StateCm>(state.cm);
  return {
    section: recordsOf<StateSection>(state.section).sort((a, b) => sectionNumber(a) - sectionNumber(b)),
    cm: new Map(cms.map((c) => [Number(c.id), c])),
  };
}

function completionOf(cm: StateCm, page: PageCm | undefined) {
  const state = typeof cm.completionstate === 'number' ? cm.completionstate : null;
  if (!page) {
    // tracked (the state has a completion state) but how is unknown without the page
    return state === null ? {} : { completiondata: { state, hascompletion: true, istrackeduser: true } };
  }
  if (page.tracking === 0) return { completion: 0 };
  return {
    completion: page.tracking,
    completiondata: {
      state: state ?? (page.done ? 1 : 0),
      hascompletion: true,
      isautomatic: page.tracking === 2,
      istrackeduser: true,
      uservisible: true,
    },
  };
}

function toModule(id: number, cm: StateCm, page: PageCm | undefined) {
  const modname = cm.module ?? page?.modname ?? '';
  const url = cm.url ?? page?.url ?? null;
  return {
    id,
    ...(url ? { url } : {}),
    name: cm.name ?? page?.name ?? '',
    ...(REAL_INSTANCE.has(modname) ? {} : { instance: id }),
    modname,
    visible: cm.visible === false ? 0 : 1,
    uservisible: cm.uservisible !== false,
    visibleoncoursepage: 1,
    ...(page?.description ? { description: page.description } : {}),
    ...completionOf(cm, page),
    dates: page?.dates ?? [],
    ...(NO_FILES_ON_PAGE.has(modname) ? { contents: [] } : {}),
  };
}

interface Filter {
  cmid?: number;
  sectionnumber?: number;
}

function readFilter(params: Record<string, unknown>): Filter {
  const out: Filter = {};
  for (const o of Array.isArray(params.options) ? params.options : []) {
    if (!isRec(o)) continue;
    const value = Number(o.value);
    if (!Number.isSafeInteger(value) || value < 0) continue;
    if (o.name === 'cmid' && value > 0) out.cmid = value;
    if (o.name === 'sectionnumber') out.sectionnumber = value;
  }
  return out;
}

/** The cmids of a section the filter keeps; null when the section itself is filtered out. */
function sectionIds(s: CourseState['section'][number], filter: Filter): number[] | null {
  if (filter.sectionnumber !== undefined && sectionNumber(s) !== filter.sectionnumber) return null;
  const listed = (s.cmlist ?? []).map(Number);
  if (filter.cmid === undefined) return listed;
  return listed.includes(filter.cmid) ? [filter.cmid] : null;
}

/** The web-service section list (delegated subsection sections are listed like normal ones, by number). */
function buildSections(state: CourseState, page: CoursePage, filter: Filter) {
  return state.section.flatMap((s) => {
    const ids = sectionIds(s, filter);
    if (!ids) return [];
    const modules = ids.flatMap((id) => {
      const cm = state.cm.get(id);
      return cm ? [toModule(id, cm, page.cms.get(id))] : [];
    });
    const id = Number(s.id);
    const section = {
      id,
      name: s.title ?? '',
      visible: s.visible === false ? 0 : 1,
      summary: page.summaries.get(id) ?? '',
      summaryformat: 1,
      section: sectionNumber(s),
      uservisible: s.visible !== false,
      ...(s.component ? { component: s.component, itemid: s.itemid ?? null } : {}),
      modules,
    };
    return [section];
  });
}

/** The cm snippet of one module; null when Moodle refuses it (the state still lists what the user may see). */
async function cmSnippet(web: WebSession, cmid: number): Promise<PageCm | null> {
  try {
    const html = await web.ajax<unknown>('core_course_get_module', { id: cmid });
    return typeof html === 'string' ? parseCmItem(html) : null;
  } catch (e) {
    if (e instanceof MoodleError) return null;
    throw e;
  }
}

async function readCoursePage(web: WebSession, courseId: number): Promise<CoursePage> {
  return parseCoursePage((await web.page(`/course/view.php?id=${courseId}`)).html);
}

async function courseContents(web: WebSession, params: Record<string, unknown>) {
  const courseId = idParam(params, 'courseid');
  const filter = readFilter(params);
  const { cmid } = filter;
  if (cmid !== undefined) {
    const [state, cm] = await Promise.all([readState(web, courseId), cmSnippet(web, cmid)]);
    const page: CoursePage = { summaries: new Map(), cms: new Map(cm ? [[cmid, cm]] : []) };
    return buildSections(state, page, filter);
  }
  const [state, page] = await Promise.all([readState(web, courseId), readCoursePage(web, courseId)]);
  return buildSections(state, page, filter);
}

interface ModuleInfo {
  id: number;
  course: number;
  modname: string;
  instance: number | null;
  name: string;
}

const moduleAnswer = (cm: ModuleInfo) => ({
  cm: { ...cm, module: cm.modname, visible: 1, uservisible: true },
  warnings: [],
});

/** core_course_get_course_module: modname/name from the cm snippet, the course from the activity page. */
async function courseModule(web: WebSession, params: Record<string, unknown>) {
  const cmid = idParam(params, 'cmid');
  const cm = await cmSnippet(web, cmid);
  if (!cm || !MODNAME.test(cm.modname)) throw notFound();
  // the next adapter usually reads this page too (memoised per session); resource/url would redirect to their target
  const view = `/mod/${cm.modname}/view.php?id=${cmid}`;
  const page = await web.page(REDIRECTS.has(cm.modname) ? `${view}&forceview=1` : view);
  const course = pageConfig(page.html).courseId;
  if (!course) throw notFound();
  const forumType = forumTypeOf(cm.modname);
  const instance = forumType ? await forumInstanceOf(web, cmid, course, forumType) : cmid;
  return moduleAnswer({ id: cmid, course, modname: cm.modname, instance, name: cm.name });
}

/**
 * core_course_get_course_module_by_instance. Forum/hsuforum: `view.php?f=<instance>` serves the forum page (context
 * instance = cmid). Every other module's instance is the cmid surrogate.
 */
async function moduleByInstance(web: WebSession, params: Record<string, unknown>) {
  const module = typeof params.module === 'string' ? params.module : '';
  const instance = idParam(params, 'instance');
  if (!MODNAME.test(module)) throw new MoodleError('Invalid parameter module.', 'invalidparameter');
  if (!REAL_INSTANCE.has(module)) return courseModule(web, { cmid: instance });
  const page = await web.page(`/mod/${module}/view.php?f=${instance}`);
  const cfg = pageConfig(page.html);
  if (!cfg.contextInstanceId || !cfg.courseId) throw notFound();
  const heading = findFirst(page.html, { attr: 'class', tag: 'h1' });
  const name = heading ? text(heading.inner) : '';
  return moduleAnswer({ id: cfg.contextInstanceId, course: cfg.courseId, modname: module, instance, name });
}

/** Completion of every tracked module as the course page shows it (tracking 1 manual, 2 automatic). */
async function completionStatus(web: WebSession, params: Record<string, unknown>) {
  const page = await readCoursePage(web, idParam(params, 'courseid'));
  const statuses = [...page.cms.values()]
    .filter((cm) => cm.tracking !== 0)
    .map((cm) => ({
      cmid: cm.id,
      modname: cm.modname,
      ...(REAL_INSTANCE.has(cm.modname) ? {} : { instance: cm.id }),
      state: cm.done ? 1 : 0,
      tracking: cm.tracking,
      hascompletion: true,
      isautomatic: cm.tracking === 2,
      istrackeduser: true,
      uservisible: true,
    }));
  return { statuses, warnings: [] };
}

/**
 * core_enrol_get_users_courses for the fields this codebase reads (id, lastaccess): the ajax
 * core_course_get_recent_courses lists the courses the user opened, with `timeaccess`. Courses never opened are
 * absent (the web service would list them with lastaccess 0).
 */
async function usersCourses(web: WebSession) {
  const raw = await web.ajax<unknown>('core_course_get_recent_courses', { userid: web.moodleUserId, limit: 0 });
  return recordsOf<Record<string, unknown>>(raw).flatMap((c) => {
    const id = Number(c.id);
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    const access = Number(c.timeaccess ?? c.lastaccess);
    return [
      {
        id,
        ...(typeof c.fullname === 'string' ? { fullname: c.fullname } : {}),
        ...(typeof c.shortname === 'string' ? { shortname: c.shortname } : {}),
        ...(Number.isSafeInteger(access) && access > 0 ? { lastaccess: access } : {}),
      },
    ];
  });
}

export const courseFunctions: WebFunctions = {
  core_course_get_contents: (web, params) => courseContents(web, params),
  core_course_get_course_module: (web, params) => courseModule(web, params),
  core_course_get_course_module_by_instance: (web, params) => moduleByInstance(web, params),
  core_completion_get_activities_completion_status: (web, params) => completionStatus(web, params),
  core_enrol_get_users_courses: (web) => usersCourses(web),
};
