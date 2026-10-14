/** Course list, course outline (sections/modules/files) and the cached full-text index behind search. */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, MoodleError, MoodleUnavailable, NotFound } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import { fromTs, nowMs } from '../time';
import type { Course, CourseOutline, FileRef, IsoJst, ModuleSummary, SearchHit, Section } from '../types';
import {
  buildIndex,
  type CourseIndexPayload,
  parseCourseIndex,
  parseQuery,
  type ScoredHit,
  searchIndex,
} from './courses-index';
import { optionalPositiveInt, requirePositiveInt } from './validate';

export type CourseClassification = 'inprogress' | 'future' | 'past' | 'all';
/** Internal lookups also use 'allincludinghidden' (courses the user hid on the Moodle dashboard). */
type FetchClassification = CourseClassification | 'allincludinghidden';

const TIMELINE_FN = 'core_course_get_enrolled_courses_by_timeline_classification';
const CONTENTS_FN = 'core_course_get_contents';

const INDEX_TTL_MS = 6 * 3600 * 1000;
const MAX_INDEX_REFRESH = 8;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const SECTION_SUMMARY_MAX = 1500;

// ------------------------------------------------------------------ raw Moodle shapes (loose, boundary only)

interface RawCourse {
  id?: number;
  fullname?: string;
  shortname?: string;
  startdate?: number;
  enddate?: number;
  viewurl?: string;
  progress?: number | null;
  hasprogress?: boolean;
  coursecategory?: string | null;
}

interface RawContentFile {
  type?: string;
  filename?: string;
  filesize?: number;
  fileurl?: string;
  mimetype?: string | null;
  timemodified?: number;
}

interface RawDate {
  label?: string;
  timestamp?: number;
  dataid?: string | null;
}

interface RawModule {
  id?: number;
  name?: string;
  modname?: string;
  url?: string;
  visible?: number | boolean;
  uservisible?: boolean;
  completion?: number;
  completiondata?: { state?: number; hascompletion?: boolean } | null;
  dates?: RawDate[] | null;
  contents?: RawContentFile[] | null;
}

interface RawSection {
  id?: number;
  name?: string;
  section?: number;
  summary?: string;
  uservisible?: boolean;
  modules?: RawModule[] | null;
}

// ------------------------------------------------------------------ pure mappers

export function mapCourse(raw: RawCourse, hidden: ReadonlySet<number>, baseUrl = ''): Course {
  const id = Number(raw.id ?? 0);
  const hasProgress = raw.hasprogress !== false && typeof raw.progress === 'number';
  const category = raw.coursecategory ? decodeEntities(raw.coursecategory) : '';
  return {
    id,
    name: decodeEntities(raw.fullname ?? ''),
    shortName: decodeEntities(raw.shortname ?? ''),
    category: category || null,
    url: raw.viewurl || `${baseUrl}/course/view.php?id=${id}`,
    start: fromTs(raw.startdate),
    end: fromTs(raw.enddate),
    progress: hasProgress ? Math.max(0, Math.min(100, Number(raw.progress))) : null,
    hidden: hidden.has(id),
  };
}

function mapFileRefs(contents: RawContentFile[] | null | undefined): FileRef[] {
  const out: FileRef[] = [];
  for (const c of contents ?? []) {
    if (c.type !== 'file' || !c.fileurl || !c.filename) continue;
    out.push({
      name: c.filename,
      size: Number(c.filesize ?? 0),
      mime: c.mimetype || null,
      url: c.fileurl,
      modified: fromTs(c.timemodified),
    });
  }
  return out;
}

/** Moodle `dataid` -> stable key; unknown ids stay verbatim. */
const DATE_KEYS: Record<string, string> = {
  duedate: 'due',
  allowsubmissionsfromdate: 'opens',
  cutoffdate: 'cutoff',
  gradingduedate: 'gradingDue',
  timeopen: 'opens',
  timeclose: 'closes',
};

function dateKeyFromLabel(label: string): string | null {
  const l = label.toLowerCase();
  if (/cut-?off/.test(l)) return 'cutoff';
  if (/due|期限|締切|締め切り/.test(l)) return 'due';
  if (/clos|終了/.test(l)) return 'closes';
  if (/open|開始/.test(l)) return 'opens';
  return null;
}

export function mapDates(raw: RawDate[] | null | undefined): Record<string, IsoJst> {
  const out: Record<string, IsoJst> = {};
  let i = 0;
  for (const d of raw ?? []) {
    i++;
    const iso = fromTs(d.timestamp);
    if (!iso) continue;
    let key = d.dataid ? (DATE_KEYS[d.dataid] ?? d.dataid) : (dateKeyFromLabel(d.label ?? '') ?? `date${i}`);
    if (key in out) key = `${key}${i}`;
    out[key] = iso;
  }
  return out;
}

export function mapCompleted(m: RawModule): boolean | null {
  const data = m.completiondata;
  if (!data || m.completion === 0 || data.hascompletion === false) return null;
  if (typeof data.state !== 'number') return null;
  return data.state === 1 || data.state === 2;
}

/** null when the module is hidden from the user (`uservisible === false`). */
function mapModule(raw: RawModule): ModuleSummary | null {
  if (raw.uservisible === false) return null;
  return {
    cmid: Number(raw.id ?? 0),
    name: decodeEntities(raw.name ?? ''),
    modname: raw.modname ?? '',
    url: raw.url || null,
    visible: raw.visible !== 0 && raw.visible !== false,
    dates: mapDates(raw.dates),
    completed: mapCompleted(raw),
    files: mapFileRefs(raw.contents),
  };
}

function sectionName(raw: string | undefined, number: number): string {
  return decodeEntities(raw ?? '') || (number === 0 ? 'General' : `Section ${number}`);
}

function mapSection(s: RawSection, summaries: boolean): Section | null {
  if (s.uservisible === false) return null;
  const number = Number(s.section ?? 0);
  return {
    id: Number(s.id ?? 0),
    number,
    name: sectionName(s.name, number),
    summary: summaries && s.summary ? htmlToMarkdown(s.summary, { maxChars: SECTION_SUMMARY_MAX }) : '',
    modules: (s.modules ?? []).flatMap((m) => mapModule(m) ?? []),
  };
}

/** `summaries: false` skips the HTML -> Markdown pass (search index does not keep summaries). */
export function mapSections(raw: RawSection[] | null | undefined, opts: { summaries?: boolean } = {}): Section[] {
  return (raw ?? []).flatMap((s) => mapSection(s, opts.summaries ?? true) ?? []);
}

// ------------------------------------------------------------------ services

async function fetchCourses(
  ctx: ServiceContext,
  api: MoodleApi,
  classification: FetchClassification,
): Promise<Course[]> {
  const res = await api.call<{ courses?: RawCourse[] } | RawCourse[]>(TIMELINE_FN, { classification, limit: 0 });
  const raw = Array.isArray(res) ? res : (res?.courses ?? []);
  const hidden = new Set(ctx.user.settings.hiddenCourseIds);
  return raw.map((c) => mapCourse(c, hidden, api.baseUrl));
}

export async function listCourses(
  ctx: ServiceContext,
  opts: { classification?: CourseClassification; includeHidden?: boolean } = {},
): Promise<Course[]> {
  const api = await ctx.moodle();
  const courses = await fetchCourses(ctx, api, opts.classification ?? 'inprogress');
  return opts.includeHidden ? courses : courses.filter((c) => !c.hidden);
}

/** Every enrolled course incl. ones hidden on the Moodle dashboard (memoised per request); for name lookups. */
export async function listAllCourses(ctx: ServiceContext): Promise<Course[]> {
  return fetchCourses(ctx, await ctx.moodle(), 'allincludinghidden');
}

/** Course from the (memoised) full list; a minimal stand-in when Moodle does not list it. */
async function lookupCourse(ctx: ServiceContext, api: MoodleApi, courseId: number): Promise<Course> {
  const all = await fetchCourses(ctx, api, 'allincludinghidden');
  return (
    all.find((c) => c.id === courseId) ??
    mapCourse({ id: courseId, fullname: `Course ${courseId}` }, new Set(ctx.user.settings.hiddenCourseIds), api.baseUrl)
  );
}

async function loadOutline(
  api: MoodleApi,
  course: Course,
  opts: { sectionNumber?: number; summaries?: boolean } = {},
): Promise<CourseOutline> {
  const { sectionNumber } = opts;
  const params: Record<string, unknown> = { courseid: course.id };
  if (sectionNumber !== undefined) params.options = [{ name: 'sectionnumber', value: sectionNumber }];
  const raw = await api.call<RawSection[]>(CONTENTS_FN, params);
  let sections = mapSections(Array.isArray(raw) ? raw : [], { summaries: opts.summaries });
  if (sectionNumber !== undefined) {
    sections = sections.filter((s) => s.number === sectionNumber);
    if (sections.length === 0) throw new NotFound(`Section ${sectionNumber} was not found in this course.`);
  }
  return { course, sections };
}

export async function getCourseOutline(
  ctx: ServiceContext,
  courseId: number,
  opts: { sectionNumber?: number } = {},
): Promise<CourseOutline> {
  requirePositiveInt(courseId, 'course_id');
  const { sectionNumber } = opts;
  if (sectionNumber !== undefined && (!Number.isInteger(sectionNumber) || sectionNumber < 0)) {
    throw new InvalidInput('section must be a non-negative integer.');
  }
  const api = await ctx.moodle();
  const course = await lookupCourse(ctx, api, courseId);
  return loadOutline(api, course, { sectionNumber });
}

// ------------------------------------------------------------------ search

interface IndexCache {
  payloads: Map<number, CourseIndexPayload>;
  updatedAt: Map<number, number>;
}

/** Cached indexes by course; an unreadable row counts as missing. */
async function readIndexCache(ctx: ServiceContext): Promise<IndexCache> {
  const cache: IndexCache = { payloads: new Map(), updatedAt: new Map() };
  for (const row of await ctx.store.getCourseIndex(ctx.user.id)) {
    const payload = parseCourseIndex(row.json);
    if (!payload) continue;
    cache.updatedAt.set(row.courseId, row.updatedAt);
    cache.payloads.set(row.courseId, payload);
  }
  return cache;
}

/** Courses without a fresh index: missing first, then the oldest. */
function staleCourses(targets: Course[], updatedAt: ReadonlyMap<number, number>, now: number): Course[] {
  return targets
    .filter((c) => {
      const at = updatedAt.get(c.id);
      return at === undefined || now - at > INDEX_TTL_MS;
    })
    .sort((a, b) => (updatedAt.get(a.id) ?? 0) - (updatedAt.get(b.id) ?? 0));
}

async function refreshIndex(
  ctx: ServiceContext,
  api: MoodleApi,
  course: Course,
  now: number,
): Promise<[number, CourseIndexPayload] | null> {
  try {
    const index = buildIndex(await loadOutline(api, course, { summaries: false }));
    await ctx.store.putCourseIndex({
      userId: ctx.user.id,
      courseId: course.id,
      json: JSON.stringify(index),
      updatedAt: now,
    });
    return [course.id, index];
  } catch (e) {
    // One broken course must not fail the whole search; auth/budget errors still surface.
    if (e instanceof MoodleError || e instanceof MoodleUnavailable) return null;
    throw e;
  }
}

export async function searchCourseContent(
  ctx: ServiceContext,
  query: string,
  opts: { courseId?: number; limit?: number } = {},
): Promise<{ hits: SearchHit[]; searchedCourses: number; refreshed: number; skipped: number }> {
  const terms = parseQuery(query);
  if (terms.length === 0) throw new InvalidInput('The search query is empty.');
  const courseId = optionalPositiveInt(opts.courseId, 'course_id');
  const limit = Math.min(SEARCH_MAX_LIMIT, optionalPositiveInt(opts.limit, 'limit') ?? SEARCH_DEFAULT_LIMIT);
  const api = await ctx.moodle();

  const targets =
    courseId !== undefined
      ? [await lookupCourse(ctx, api, courseId)]
      : (await fetchCourses(ctx, api, 'inprogress')).filter((c) => !c.hidden);

  const cache = await readIndexCache(ctx);
  const now = nowMs();
  const stale = staleCourses(targets, cache.updatedAt, now);
  // Capped per call for the Moodle budget and CPU; the rest catch up on later calls.
  const fresh = await Promise.all(stale.slice(0, MAX_INDEX_REFRESH).map((c) => refreshIndex(ctx, api, c, now)));
  let refreshed = 0;
  for (const entry of fresh) {
    if (!entry) continue;
    refreshed++;
    cache.payloads.set(entry[0], entry[1]);
  }

  const scored: ScoredHit[] = [];
  let searchedCourses = 0;
  for (const course of targets) {
    const payload = cache.payloads.get(course.id);
    if (!payload) continue;
    searchedCourses++;
    scored.push(...searchIndex(payload, course, terms));
  }
  scored.sort((a, b) => b.score - a.score); // stable: keeps course/section order within a score
  return {
    hits: scored.slice(0, limit).map((s) => s.hit),
    searchedCourses,
    refreshed,
    skipped: Math.max(0, stale.length - MAX_INDEX_REFRESH),
  };
}
