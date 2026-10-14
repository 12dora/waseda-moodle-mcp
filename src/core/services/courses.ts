/** Course list (scope-aware), course outline (sections/modules/files) and the search entry point. */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, NotFound } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import type { RawContentFile, RawDate, RawModule, RawSection } from '../moodle/raw-course';
import { fromTs } from '../time';
import type { Course, CourseOutline, FileRef, IsoJst, ModuleSummary, SearchHit, Section } from '../types';
import { fetchEnrolledCourses, mapCourse, resolveScope } from './scope';
import { searchSnapshots } from './sweep';
import { optionalPositiveInt, requirePositiveInt } from './validate';

const CONTENTS_FN = 'core_course_get_contents';

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const SECTION_SUMMARY_MAX = 1500;

// ------------------------------------------------------------------ raw Moodle shapes (loose, boundary only)

// ------------------------------------------------------------------ pure mappers

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

/** `summaries: false` skips the HTML -> Markdown pass (snapshots do not keep summaries). */
export function mapSections(raw: RawSection[] | null | undefined, opts: { summaries?: boolean } = {}): Section[] {
  return (raw ?? []).flatMap((s) => mapSection(s, opts.summaries ?? true) ?? []);
}

// ------------------------------------------------------------------ services

/** Courses in the user's scope (confirmed "my courses", or the automatic suggestion); `scope: 'all'` = every enrolled. */
export async function listCourses(ctx: ServiceContext, opts: { scope?: 'mine' | 'all' } = {}): Promise<Course[]> {
  const { courses } = await resolveScope(ctx);
  return opts.scope === 'all' ? courses : courses.filter((c) => c.mine);
}

/**
 * Every enrolled course incl. ones hidden on the Moodle dashboard (one call); for name lookups. `mine` follows the
 * confirmed selection only; `suggested` / `lastAccess` need resolveScope.
 */
export async function listAllCourses(ctx: ServiceContext): Promise<Course[]> {
  const mineIds = ctx.user.settings.myCourseIds;
  const courses = await fetchEnrolledCourses(await ctx.moodle());
  return mineIds ? courses.map((c) => ({ ...c, mine: mineIds.includes(c.id) })) : courses;
}

/** Course from the full list; a minimal stand-in when Moodle does not list it. */
async function lookupCourse(ctx: ServiceContext, api: MoodleApi, courseId: number): Promise<Course> {
  const all = await listAllCourses(ctx);
  return all.find((c) => c.id === courseId) ?? mapCourse({ id: courseId, fullname: `Course ${courseId}` }, api.baseUrl);
}

async function loadOutline(
  api: MoodleApi,
  course: Course,
  opts: { sectionNumber?: number } = {},
): Promise<CourseOutline> {
  const { sectionNumber } = opts;
  const params: Record<string, unknown> = { courseid: course.id };
  if (sectionNumber !== undefined) params.options = [{ name: 'sectionnumber', value: sectionNumber }];
  const raw = await api.call<RawSection[]>(CONTENTS_FN, params);
  let sections = mapSections(Array.isArray(raw) ? raw : []);
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

export async function searchCourseContent(
  ctx: ServiceContext,
  query: string,
  opts: { courseId?: number; limit?: number } = {},
): Promise<{ hits: SearchHit[]; searchedCourses: number; refreshed: number; skipped: number }> {
  if (!query.trim()) throw new InvalidInput('The search query is empty.');
  const courseId = optionalPositiveInt(opts.courseId, 'course_id');
  const limit = Math.min(SEARCH_MAX_LIMIT, optionalPositiveInt(opts.limit, 'limit') ?? SEARCH_DEFAULT_LIMIT);
  return searchSnapshots(ctx, await resolveScope(ctx), query, { courseId, limit });
}
