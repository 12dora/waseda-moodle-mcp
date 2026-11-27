/**
 * Page, url, label, book and every other module (resource, folder, …) as generic content. Every read names the cmid
 * (call hint), so the web channel reads that activity's page only. On the web channel the course contents carry no
 * files: resource and folder files come from their activity pages; a book's chapters cannot be read there.
 */

import type { MoodleApi } from '../../context';
import { MoodleError, NotFound } from '../../errors';
import { decodeEntities, htmlToMarkdown } from '../../html';
import type { RawDate } from '../../moodle/raw-course';
import { folderFiles, resourceFiles } from '../../moodle/web/adapters/content';
import type { ContentDetail, FileRef } from '../../types';
import { type ActivityInfo, type CourseModuleInfo, mapFile, mapFiles, pickLang, type RawFile } from '../shared';
import { webSessionOf } from './web';

const md = (html: string | null | undefined, lang?: string | null): string =>
  htmlToMarkdown(pickLang(html, lang), { maxChars: 20_000 });

interface RawModuleContent extends RawFile {
  type?: string;
  content?: string | null;
}

export interface RawModule {
  id: number;
  name?: string | null;
  modname?: string | null;
  description?: string | null;
  dates?: RawDate[] | null;
  contents?: RawModuleContent[] | null;
}

export interface RawPage {
  coursemodule: number;
  name?: string | null;
  intro?: string | null;
  content?: string | null;
  contentfiles?: RawFile[] | null;
}

export interface RawUrl {
  coursemodule: number;
  name?: string | null;
  intro?: string | null;
  externalurl?: string | null;
}

type ContentInfo = ActivityInfo & { courseId: number; modname: string };

function baseContent(cm: CourseModuleInfo, info: ContentInfo, name: string | null | undefined): ContentDetail {
  return {
    type: 'content',
    cmid: cm.cmid,
    courseId: cm.courseId,
    courseName: info.courseName,
    name: decodeEntities(name ?? cm.name),
    modname: info.modname,
    url: info.url,
    description: '',
    body: null,
    externalUrl: null,
    files: [],
  };
}

/** Files of `core_course_get_contents`; folder entries keep their sub-path in the name. */
export function mapContentFiles(contents: RawModuleContent[] | null | undefined): FileRef[] {
  const out: FileRef[] = [];
  for (const c of contents ?? []) {
    if (c.type !== 'file') continue;
    const dir = c.filepath && c.filepath !== '/' ? c.filepath.replace(/^\/+/, '') : '';
    const f = mapFile(c, dir);
    if (f) out.push(f);
  }
  return out;
}

interface BookItem {
  title?: string;
  subitems?: BookItem[];
}

/** Book chapter list from the `structure` content entry as an indented markdown list. */
export function mapBookStructure(contents: RawModuleContent[] | null | undefined): string | null {
  const entry = (contents ?? []).find((c) => c.filename === 'structure' && c.content);
  if (!entry?.content) return null;
  let items: BookItem[];
  try {
    items = JSON.parse(entry.content) as BookItem[];
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const lines: string[] = [];
  const walk = (list: BookItem[], depth: number) => {
    for (const it of list) {
      lines.push(`${'  '.repeat(depth)}- ${decodeEntities(it.title ?? '')}`);
      if (it.subitems?.length) walk(it.subitems, depth + 1);
    }
  };
  walk(items, 0);
  return lines.join('\n') || null;
}

function mapModuleContent(raw: RawModule, cm: CourseModuleInfo, info: ContentInfo): ContentDetail {
  const base = baseContent(cm, info, raw.name);
  const description = md(raw.description, info.lang);
  if (info.modname === 'label') return { ...base, body: description || null };
  if (info.modname === 'book') return { ...base, description, body: mapBookStructure(raw.contents) };
  return {
    ...base,
    description,
    files: mapContentFiles(raw.contents),
    externalUrl: raw.contents?.find((c) => c.type === 'url')?.fileurl ?? null,
  };
}

function mapPage(raw: RawPage, cm: CourseModuleInfo, info: ContentInfo): ContentDetail {
  return {
    ...baseContent(cm, info, raw.name),
    description: md(raw.intro, info.lang),
    body: md(raw.content, info.lang) || null,
    files: mapFiles(raw.contentfiles),
  };
}

function mapUrl(raw: RawUrl, cm: CourseModuleInfo, info: ContentInfo): ContentDetail {
  return {
    ...baseContent(cm, info, raw.name),
    description: md(raw.intro, info.lang),
    externalUrl: raw.externalurl || null,
  };
}

async function fromTypedModule(api: MoodleApi, cm: CourseModuleInfo, info: ContentInfo): Promise<ContentDetail | null> {
  const args = { courseids: [cm.courseId] };
  const hint = { cmid: cm.cmid };
  if (cm.modname === 'page') {
    const res = await api.call<{ pages?: RawPage[] | null }>('mod_page_get_pages_by_courses', args, hint);
    const raw = (res?.pages ?? []).find((p) => p.coursemodule === cm.cmid);
    return raw ? mapPage(raw, cm, info) : null;
  }
  if (cm.modname === 'url') {
    const res = await api.call<{ urls?: RawUrl[] | null }>('mod_url_get_urls_by_courses', args, hint);
    const raw = (res?.urls ?? []).find((u) => u.coursemodule === cm.cmid);
    return raw ? mapUrl(raw, cm, info) : null;
  }
  return null;
}

/** The module's row of `core_course_get_contents` (name, description, dates, files). */
export async function fetchModuleRow(api: MoodleApi, cm: CourseModuleInfo): Promise<RawModule> {
  const sections = await api.call<Array<{ modules?: RawModule[] | null }>>(
    'core_course_get_contents',
    { courseid: cm.courseId, options: [{ name: 'cmid', value: cm.cmid }] },
    { cmid: cm.cmid },
  );
  const mod = (Array.isArray(sections) ? sections : []).flatMap((s) => s.modules ?? []).find((m) => m.id === cm.cmid);
  if (!mod) throw new NotFound(`Activity ${cm.cmid} was not found or is not visible.`);
  return mod;
}

const WEB_FILES: Record<string, typeof resourceFiles> = { resource: resourceFiles, folder: folderFiles };
const WEB_BOOK_NOTE = '_The chapters of this book cannot be read through the Moodle web session; open it in Moodle._';

/**
 * The web channel's course contents list no files and no book structure: resource and folder files are read from
 * the activity page (a failure leaves the list empty, the rest is still worth showing); a book says it is unreadable.
 */
async function completeOnWeb(api: MoodleApi, raw: RawModule, cm: CourseModuleInfo): Promise<RawModule | string> {
  if (cm.modname === 'book') return WEB_BOOK_NOTE;
  const read = WEB_FILES[cm.modname];
  if (!read || (raw.contents ?? []).some((c) => c.type === 'file')) return raw;
  const contents = await read(webSessionOf(api), cm.cmid).catch((e: unknown) => {
    if (e instanceof MoodleError) return [];
    throw e;
  });
  return { ...raw, contents };
}

export async function loadContent(api: MoodleApi, cm: CourseModuleInfo, info: ContentInfo): Promise<ContentDetail> {
  const typed = await fromTypedModule(api, cm, info);
  if (typed) return typed;
  // label, book, resource, folder and everything else (also the fallback when a page/url row is missing)
  const raw = await fetchModuleRow(api, cm);
  if (api.channel !== 'web') return mapModuleContent(raw, cm, info);
  const done = await completeOnWeb(api, raw, cm);
  if (typeof done !== 'string') return mapModuleContent(done, cm, info);
  return { ...mapModuleContent(raw, cm, info), body: done };
}
