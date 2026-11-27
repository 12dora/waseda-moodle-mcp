/**
 * download_course_files: the files of one activity, per channel. ws: the course contents list them (assignments: one
 * course-wide call). web: a resource's file from its view page (counts as viewing it), a page's files from its content,
 * an assignment's from its page, a folder as one ZIP link (no request now).
 */

import type { MoodleApi } from '../context';
import { NotFound } from '../errors';
import { resourceFiles } from '../moodle/web/adapters/content';
import { referencedUrls } from '../moodle/web/parse/content';
import { FOLDER_ZIP_PATH } from '../moodle/wire';
import { webSessionOf } from './activity/web';
import type { DownloadKind } from './downloads';
import { failureReason } from './downloads-local';

export interface RawEntry {
  type?: string;
  filename?: string;
  filepath?: string;
  filesize?: number;
  fileurl?: string;
}

/** One activity to download, in course order. */
export interface Item {
  cmid: number;
  kind: DownloadKind;
  name: string;
  section: number;
  sectionName: string;
  contents: RawEntry[];
}

/** A page's own index.html is its text, not one of its files. */
export const isListedFile = (item: Item, e: RawEntry) =>
  e.type === 'file' && !!e.fileurl && !(item.kind === 'page' && e.filename === 'index.html' && e.filepath === '/');

export interface Found {
  name: string;
  /** Sub-folders inside the activity ('' for none), `/`-separated. */
  subdir: string;
  /** Absolute Moodle URL (pluginfile or folder ZIP). */
  url: string;
  size: number | null;
  zip: boolean;
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function foundOf(e: RawEntry): Found[] {
  if (!e.fileurl) return [];
  const name = e.filename || decodePart(e.fileurl.split('?')[0]?.split('/').pop() ?? '');
  const subdir = (e.filepath ?? '/').replace(/^\/+|\/+$/g, '');
  const size = typeof e.filesize === 'number' && e.filesize > 0 ? e.filesize : null;
  return [{ name, subdir, url: e.fileurl, size, zip: false }];
}

const PAGE_FILE = /^\/pluginfile\.php\/\d+\/mod_page\/content\/\d+\/(.+)$/;

/** The page's own files its content refers to (the web page lists no `contentfiles`), once each. */
function pageContentFiles(html: string, baseUrl: string): Found[] {
  const origin = new URL(baseUrl).origin;
  const found = new Map<string, Found>();
  for (const ref of referencedUrls(html)) {
    const u = URL.canParse(ref, baseUrl) ? new URL(ref, baseUrl) : null;
    const tail = u?.origin === origin ? PAGE_FILE.exec(u.pathname)?.[1] : undefined;
    if (!u || !tail || found.has(u.pathname)) continue;
    const parts = tail.split('/').map(decodePart);
    const name = parts.pop() ?? '';
    found.set(u.pathname, { name, subdir: parts.join('/'), url: `${origin}${u.pathname}`, size: null, zip: false });
  }
  return [...found.values()];
}

interface RawPageRow {
  coursemodule?: number;
  content?: string | null;
  contentfiles?: RawEntry[] | null;
}

async function pageFiles(api: MoodleApi, courseId: number, item: Item): Promise<Found[]> {
  const res = await api.call<{ pages?: RawPageRow[] | null }>(
    'mod_page_get_pages_by_courses',
    { courseids: [courseId] },
    { cmid: item.cmid },
  );
  const page = (res?.pages ?? []).find((p) => p.coursemodule === item.cmid);
  if (!page) throw new NotFound('Moodle did not show this page.');
  const listed = (page.contentfiles ?? []).flatMap(foundOf);
  return listed.length > 0 ? listed : pageContentFiles(page.content ?? '', api.baseUrl);
}

interface RawAssignment {
  cmid?: number;
  introattachments?: RawEntry[] | null;
  /** Moodle 4+: the "Activity instructions" files, shown beside the description's. */
  activityattachments?: RawEntry[] | null;
}

interface RawAssignments {
  courses?: Array<{ assignments?: RawAssignment[] | null }> | null;
}

/** The description's and the activity instructions' files, each file once. */
function instructionFiles(assign: RawAssignment): Found[] {
  const byUrl = new Map<string, RawEntry>();
  for (const e of [...(assign.introattachments ?? []), ...(assign.activityattachments ?? [])]) {
    if (e.fileurl && !byUrl.has(e.fileurl)) byUrl.set(e.fileurl, e);
  }
  return [...byUrl.values()].flatMap(foundOf);
}

/** The instructions' files; ws reads every assignment of the course in one call, web the one assignment's page. */
async function assignFiles(api: MoodleApi, courseId: number, item: Item): Promise<Found[]> {
  const hint = api.channel === 'web' ? { cmid: item.cmid } : undefined;
  const res = await api.call<RawAssignments>('mod_assign_get_assignments', { courseids: [courseId] }, hint);
  const all = (res?.courses ?? []).flatMap((c) => c.assignments ?? []);
  const assign = all.find((a) => a.cmid === item.cmid);
  if (!assign) throw new NotFound('Moodle did not show this assignment.');
  return instructionFiles(assign);
}

type Resolver = (api: MoodleApi, courseId: number, item: Item) => Promise<Found[]>;

const zipOf = (api: MoodleApi, item: Item): Found => ({
  name: `${item.name}.zip`,
  subdir: '',
  url: `${api.baseUrl}${FOLDER_ZIP_PATH}?id=${item.cmid}`,
  size: null,
  zip: true,
});

const fromContents: Resolver = async (_api, _course, item) =>
  item.contents.filter((e) => isListedFile(item, e)).flatMap(foundOf);

const WS_RESOLVERS: Record<DownloadKind, Resolver> = {
  resource: fromContents,
  folder: fromContents,
  page: fromContents,
  assign: assignFiles,
};

const WEB_RESOLVERS: Record<DownloadKind, Resolver> = {
  resource: async (api, _course, item) => (await resourceFiles(webSessionOf(api), item.cmid)).flatMap(foundOf),
  folder: async (api, _course, item) => [zipOf(api, item)],
  page: pageFiles,
  assign: assignFiles,
};

export type Resolved = { files: Found[] } | { reason: string };

export async function resolveItem(api: MoodleApi, courseId: number, item: Item): Promise<Resolved> {
  const resolvers = api.channel === 'web' ? WEB_RESOLVERS : WS_RESOLVERS;
  try {
    return { files: await resolvers[item.kind](api, courseId, item) };
  } catch (e) {
    return { reason: failureReason(e) };
  }
}
