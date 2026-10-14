/** Helpers shared by the activity, forum and message services (BE-3). */

import type { MoodleApi, ServiceContext } from '../context';
import { MoodleError, MoodleUnavailable, NotFound } from '../errors';
import { decodeEntities } from '../html';
import { fromTs } from '../time';
import type { FileRef } from '../types';
import { listAllCourses } from './courses';

/** Shape of a Moodle file record; forum post attachments use `url` instead of `fileurl`. */
export interface RawFile {
  filename?: string | null;
  filepath?: string | null;
  filesize?: number | null;
  fileurl?: string | null;
  url?: string | null;
  mimetype?: string | null;
  timemodified?: number | null;
}

/** What every activity loader needs besides the Moodle ids. */
export interface ActivityInfo {
  courseName: string;
  url: string;
  lang?: string | null;
}

export function clampInt(v: number | undefined | null, dflt: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** Drops `token=` and rewrites `/pluginfile.php/` to the `/webservice/pluginfile.php/` form. */
export function cleanFileUrl(u: string): string {
  let out = u.replace(/^(https?:\/\/[^/]+)\/pluginfile\.php\//, '$1/webservice/pluginfile.php/');
  if (/[?&]token=/.test(out)) out = out.replace(/([?&])token=[^&#]*&?/, '$1').replace(/[?&]$/, '');
  return out;
}

function nameFromUrl(url: string): string {
  const last = url.split('?')[0]?.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function mapFile(raw: RawFile | null | undefined, namePrefix = ''): FileRef | null {
  const url = raw?.fileurl || raw?.url;
  if (!raw || !url) return null;
  return {
    name: namePrefix + (raw.filename || nameFromUrl(url)),
    size: raw.filesize ?? 0,
    mime: raw.mimetype ?? null,
    url: cleanFileUrl(url),
    modified: fromTs(raw.timemodified),
  };
}

export function mapFiles(list: RawFile[] | null | undefined): FileRef[] {
  const out: FileRef[] = [];
  for (const f of list ?? []) {
    const m = mapFile(f);
    if (m) out.push(m);
  }
  return out;
}

// ------------------------------------------------------------------ multilang

const SPAN_TAG = /<(\/?)span\b[^>]*>/gi;
const LANG_OPEN = /^<span\s+(?:lang="([\w-]+)"\s+class="multilang"|class="multilang"\s+lang="([\w-]+)")\s*>/;

interface LangSpan {
  lang: string;
  inner: string;
  end: number;
}

const normLang = (l: string) => l.toLowerCase().replace('_', '-');

/** The multilang span that starts exactly at `pos`; its end is found by counting nested spans. */
function readLangSpan(html: string, pos: number): LangSpan | null {
  const open = LANG_OPEN.exec(html.slice(pos, pos + 160));
  if (!open) return null;
  const bodyStart = pos + open[0].length;
  let depth = 1;
  SPAN_TAG.lastIndex = bodyStart;
  for (let m = SPAN_TAG.exec(html); m; m = SPAN_TAG.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      return { lang: open[1] ?? open[2] ?? '', inner: html.slice(bodyStart, m.index), end: m.index + m[0].length };
    }
  }
  return null;
}

/** Adjacent spans (whitespace between them allowed) form one run: the translations of one text. */
function readRun(html: string, pos: number): { spans: LangSpan[]; end: number } {
  const spans: LangSpan[] = [];
  let end = pos;
  let span = readLangSpan(html, pos);
  while (span) {
    spans.push(span);
    end = span.end;
    let next = end;
    while (/\s/.test(html.charAt(next))) next++;
    span = readLangSpan(html, next);
  }
  return { spans, end };
}

function chooseSpan(spans: LangSpan[], lang: string): LangSpan | undefined {
  const want = normLang(lang);
  const matches = (s: LangSpan) => {
    const l = normLang(s.lang);
    return l !== '' && (want.startsWith(l) || l.startsWith(want));
  };
  return spans.find(matches) ?? spans.find((s) => normLang(s.lang) === 'en') ?? spans[0];
}

/**
 * Like filter_multilang (which does not run on the WS path): every run of adjacent
 * `<span lang=".." class="multilang">` siblings is replaced by the span for `lang`, else English, else the first.
 * Nested spans and nested runs are handled.
 */
export function pickLang(html: string | null | undefined, lang?: string | null): string {
  if (!html) return '';
  if (!lang || !html.includes('multilang')) return html;
  let out = '';
  let pos = 0;
  for (let i = html.indexOf('<span', pos); i !== -1; i = html.indexOf('<span', pos)) {
    const run = readRun(html, i);
    const pick = chooseSpan(run.spans, lang);
    if (!pick) {
      out += html.slice(pos, i + 5);
      pos = i + 5;
      continue;
    }
    out += html.slice(pos, i) + pickLang(pick.inner, lang);
    pos = run.end;
  }
  return out + html.slice(pos);
}

// ------------------------------------------------------------------ course names / cmid lookup

/** Course id -> decoded course name from the memoised full course list. Empty map when Moodle fails. */
export async function courseNameMap(ctx: ServiceContext): Promise<Map<number, string>> {
  try {
    return new Map((await listAllCourses(ctx)).map((c) => [c.id, c.name]));
  } catch (e) {
    if (e instanceof MoodleError || e instanceof MoodleUnavailable) return new Map();
    throw e;
  }
}

export interface CourseModuleInfo {
  cmid: number;
  courseId: number;
  modname: string;
  instance: number;
  name: string;
}

interface RawCourseModule {
  course?: number;
  modname?: string;
  instance?: number;
  name?: string;
}

/** `core_course_get_course_module(cmid)`; the payload is `{cm:{…}}` (flat tolerated). */
export async function getCourseModule(api: MoodleApi, cmid: number): Promise<CourseModuleInfo> {
  type Res = { cm?: RawCourseModule } & RawCourseModule;
  let res: Res;
  try {
    res = await api.call<Res>('core_course_get_course_module', { cmid });
  } catch (e) {
    if (e instanceof MoodleError) {
      throw new NotFound(`Activity ${cmid} was not found or is not accessible (${e.message}).`);
    }
    throw e;
  }
  const cm = res?.cm ?? res;
  if (!cm || typeof cm.course !== 'number' || typeof cm.modname !== 'string' || typeof cm.instance !== 'number') {
    throw new NotFound(`Activity ${cmid} was not found or is not accessible.`);
  }
  return { cmid, courseId: cm.course, modname: cm.modname, instance: cm.instance, name: decodeEntities(cm.name ?? '') };
}
