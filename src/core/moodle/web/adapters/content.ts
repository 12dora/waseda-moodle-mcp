/**
 * Web-channel emulation of the page and URL by-course lists, and the files of resource and folder activities. These
 * module instances are cmid surrogates. With a cmid hint one view page is read (Moodle counts that as viewing the
 * activity); without it the course state lists the activities by name only.
 */

import { findFirst, links, mainRegion, pageConfig } from '../html';
import {
  moduleFiles,
  parseModuleView,
  parsePageContent,
  parseUrlTarget,
  referencedUrls,
  stateModules,
} from '../parse/content';
import type { WebFunctions, WebSession } from '../types';

interface ModuleRow {
  id: number;
  coursemodule: number;
  course?: number;
  name?: string;
  intro?: string;
  content?: string;
  contentformat?: number;
  contentfiles?: never[];
  externalurl?: string;
}

interface ModuleKind {
  modname: string;
  /** The full row from the activity's view page; null when Moodle does not show it. */
  read: (web: WebSession, cmid: number) => Promise<ModuleRow | null>;
}

const identity = (cmid: number, html: string) => ({
  id: cmid,
  coursemodule: cmid,
  course: pageConfig(html).courseId ?? undefined,
});

async function readPage(web: WebSession, cmid: number): Promise<ModuleRow | null> {
  const page = await web.page(`/mod/page/view.php?id=${cmid}`);
  if (!page.url.includes('/mod/page/view.php')) return null;
  const view = parseModuleView(page.html);
  const content = parsePageContent(view.body);
  if (content === null) return null;
  return {
    ...identity(cmid, page.html),
    name: view.name,
    intro: view.intro,
    content,
    contentformat: 1,
    contentfiles: [],
  };
}

/** Moodle sends a user who may not see an activity to the course or enrolment page, not to the link's target. */
function isRefusal(baseUrl: string, location: string): boolean {
  const url = new URL(location, baseUrl);
  return url.origin === new URL(baseUrl).origin && /\/(?:course\/view|enrol\/index)\.php$/.test(url.pathname);
}

async function readUrl(web: WebSession, cmid: number): Promise<ModuleRow | null> {
  const page = await web.page(`/mod/url/view.php?id=${cmid}&redirect=0`, { follow: false });
  // A URL set to open directly redirects anyway: the target is all Moodle tells then.
  if (page.location) {
    if (isRefusal(web.baseUrl, page.location)) return null;
    return { id: cmid, coursemodule: cmid, externalurl: page.location };
  }
  const view = parseModuleView(page.html);
  return {
    ...identity(cmid, page.html),
    name: view.name,
    intro: view.intro,
    externalurl: parseUrlTarget(view.body) ?? undefined,
  };
}

/** Names only, from one ajax call per course: view pages are never read for a whole course. */
async function listed(web: WebSession, courseIds: number[], modname: string): Promise<ModuleRow[]> {
  const perCourse = await Promise.all(
    courseIds.map(async (course) => {
      const state = await web.ajax<string>('core_courseformat_get_state', { courseid: course });
      return stateModules(state, modname).map(({ cmid, name }) => ({ id: cmid, coursemodule: cmid, course, name }));
    }),
  );
  return perCourse.flat();
}

async function byCourses(
  web: WebSession,
  params: Record<string, unknown>,
  cmid: number | undefined,
  kind: ModuleKind,
): Promise<ModuleRow[]> {
  const courseIds = Array.isArray(params.courseids) ? params.courseids.map(Number) : [];
  if (cmid === undefined) return listed(web, courseIds, kind.modname);
  const row = await kind.read(web, cmid);
  if (!row) return [];
  const onlyCourse = courseIds.length === 1 ? courseIds[0] : undefined;
  return [{ ...row, course: row.course ?? onlyCourse }];
}

const PAGE: ModuleKind = { modname: 'page', read: readPage };
const LINK: ModuleKind = { modname: 'url', read: readUrl };

export const contentFunctions: WebFunctions = {
  mod_page_get_pages_by_courses: async (web, params, hint) => ({
    pages: await byCourses(web, params, hint.cmid, PAGE),
    warnings: [],
  }),
  mod_url_get_urls_by_courses: async (web, params, hint) => ({
    urls: await byCourses(web, params, hint.cmid, LINK),
    warnings: [],
  }),
};

/**
 * The file of a resource activity as `core_course_get_contents` lists it. Moodle normally answers with a redirect to
 * the file (not followed, so nothing is downloaded); an embedding or "click to open" page names it instead.
 */
export async function resourceFiles(web: WebSession, cmid: number) {
  const page = await web.page(`/mod/resource/view.php?id=${cmid}&redirect=1`, { follow: false });
  const urls = page.location ? [page.location] : referencedUrls(mainRegion(page.html));
  return moduleFiles(urls, web.baseUrl, 'mod_resource');
}

/** The files of a folder activity as `core_course_get_contents` lists them (sub-folders in `filepath`). */
export async function folderFiles(web: WebSession, cmid: number) {
  const page = await web.page(`/mod/folder/view.php?id=${cmid}`);
  // A folder displayed on the course page redirects there: only its own block may be read.
  const scope = page.url.includes('/course/view.php')
    ? (findFirst(page.html, { attr: 'id', value: `module-${cmid}` })?.inner ?? '')
    : mainRegion(page.html);
  return moduleFiles(links(scope), web.baseUrl, 'mod_folder');
}
