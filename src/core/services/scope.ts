/** "My courses": which enrolled courses count by default (confirmed selection, or an automatic suggestion). */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, MoodleError } from '../errors';
import { decodeEntities } from '../html';
import { fromTs, nowMs } from '../time';
import type { Course, UserSettings } from '../types';
import { lookupTerms, termFit } from './syllabus';
import { requirePositiveInt } from './validate';

const TIMELINE_FN = 'core_course_get_enrolled_courses_by_timeline_classification';
const ENROL_FN = 'core_enrol_get_users_courses';
const DAY_MS = 86_400_000;
const RECENT_ACCESS_MS = 21 * DAY_MS;

export interface CourseScope {
  mode: 'mine' | 'auto';
  mine: Set<number>;
  courses: Course[]; // every enrolled course, flags filled
}

interface RawCourse {
  id?: number;
  fullname?: string;
  shortname?: string;
  idnumber?: string;
  startdate?: number;
  enddate?: number;
  viewurl?: string;
  progress?: number | null;
  hasprogress?: boolean;
  coursecategory?: string | null;
}

interface RawEnrolled {
  id?: number;
  lastaccess?: number;
}

/** Course `idnumber`s containing "ZZ" are non-class 提供コンテンツ courses (library, career, seminars...). */
export function classifyCourse(idnumber: string | null | undefined): 'class' | 'other' {
  return idnumber?.includes('ZZ') ? 'other' : 'class';
}

/** Flags start neutral; resolveScope fills them. */
export function mapCourse(raw: RawCourse, baseUrl = ''): Course {
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
    kind: classifyCourse(raw.idnumber),
    mine: false,
    suggested: false,
    term: null,
    lastAccess: null,
  };
}

async function fetchRawCourses(api: MoodleApi): Promise<RawCourse[]> {
  const res = await api.call<{ courses?: RawCourse[] } | RawCourse[]>(TIMELINE_FN, {
    classification: 'allincludinghidden',
    limit: 0,
  });
  return Array.isArray(res) ? res : (res?.courses ?? []);
}

/** Every enrolled course from ONE Moodle call (also those hidden on the Moodle dashboard); flags are neutral. */
export async function fetchEnrolledCourses(api: MoodleApi): Promise<Course[]> {
  return (await fetchRawCourses(api)).map((c) => mapCourse(c, api.baseUrl));
}

/** course id -> lastaccess (unix s). Best effort: the scope still works without it. */
async function fetchLastAccess(api: MoodleApi): Promise<Map<number, number>> {
  try {
    const raw = await api.call<RawEnrolled[]>(ENROL_FN, { userid: api.moodleUserId, returnusercount: 0 });
    const out = new Map<number, number>();
    for (const c of Array.isArray(raw) ? raw : []) if (c.id && c.lastaccess) out.set(c.id, c.lastaccess);
    return out;
  } catch (e) {
    if (e instanceof MoodleError) return new Map();
    throw e;
  }
}

interface Signals {
  eventCourses: ReadonlySet<number> | null;
  now: number;
}

/**
 * class course AND (term is current OR (term unknown AND (recent access OR upcoming calendar event))).
 * A known, non-current term (e.g. 冬クォーター in October) is never suggested, even with recent access.
 */
function isSuggested(course: Course, signals: Signals): boolean {
  if (course.kind !== 'class') return false;
  const fit = termFit(course.term, signals.now);
  if (fit !== 'unknown') return fit === 'current';
  const accessedAt = course.lastAccess ? Date.parse(course.lastAccess) : 0;
  return accessedAt >= signals.now - RECENT_ACCESS_MS || signals.eventCourses?.has(course.id) === true;
}

interface ScopeState {
  /** Courses with a calendar event in the next 30 days, when a due-events call already ran in this request. */
  eventCourses: ReadonlySet<number> | null;
  /** Kill switch for the public syllabus lookup (callers pass it from their env). */
  syllabusLookup: boolean;
  scope: Promise<CourseScope> | null;
  terms: Promise<Map<number, string | null>> | null;
}

const states = new WeakMap<ServiceContext, ScopeState>();

function stateOf(ctx: ServiceContext): ScopeState {
  let s = states.get(ctx);
  if (!s) {
    s = { eventCourses: null, syllabusLookup: ctx.syllabusLookup ?? true, scope: null, terms: null };
    states.set(ctx, s);
  }
  return s;
}

async function lookupCourseTerms(ctx: ServiceContext, raw: RawCourse[], enabled: boolean) {
  const lookups = raw.map((c) => ({ id: Number(c.id ?? 0), idnumber: c.idnumber ?? '', name: c.fullname ?? '' }));
  const infos = await lookupTerms(ctx, lookups, { syllabusLookup: enabled });
  return new Map([...infos].map(([id, info]) => [id, info?.term ?? null]));
}

async function computeScope(ctx: ServiceContext, state: ScopeState): Promise<CourseScope> {
  const api = await ctx.moodle();
  const raw = await fetchRawCourses(api);
  state.terms ??= lookupCourseTerms(ctx, raw, state.syllabusLookup);
  const [access, terms] = await Promise.all([fetchLastAccess(api), state.terms]);
  const confirmed = ctx.user.settings.myCourseIds;
  const signals = { eventCourses: state.eventCourses, now: nowMs() };
  const courses = raw.map((r) => {
    const base = { ...mapCourse(r, api.baseUrl), lastAccess: fromTs(access.get(Number(r.id))) };
    const course = { ...base, term: terms.get(base.id) ?? null };
    const suggested = isSuggested(course, signals);
    return { ...course, suggested, mine: confirmed ? confirmed.includes(course.id) : suggested };
  });
  return { mode: confirmed ? 'mine' : 'auto', mine: new Set(courses.filter((c) => c.mine).map((c) => c.id)), courses };
}

/**
 * Memoised per ServiceContext (= per request). `syllabusLookup: false` (env kill switch) stops the public syllabus
 * fetches; it applies to the first resolution of a context.
 */
export function resolveScope(ctx: ServiceContext, opts: { syllabusLookup?: boolean } = {}): Promise<CourseScope> {
  const state = stateOf(ctx);
  if (state.scope === null) state.syllabusLookup = opts.syllabusLookup ?? state.syllabusLookup;
  state.scope ??= computeScope(ctx, state);
  return state.scope;
}

/** Feeds the calendar signal of the automatic suggestion from a due-events call that already happened. */
export function noteUpcomingEventCourses(ctx: ServiceContext, courseIds: Iterable<number>): void {
  const state = stateOf(ctx);
  state.eventCourses = new Set(courseIds);
  state.scope = null;
}

function validateIds(ids: number[], enrolled: ReadonlySet<number>): number[] {
  const unique = [...new Set(ids.map((id) => requirePositiveInt(id, 'course id')))];
  const unknown = unique.filter((id) => !enrolled.has(id));
  if (unknown.length) throw new InvalidInput(`Not enrolled in course(s): ${unknown.join(', ')}.`);
  return unique;
}

/** `null` returns to the automatic suggestion. Only changes our own filter, never Moodle. */
export async function setMyCourses(ctx: ServiceContext, ids: number[] | null): Promise<UserSettings> {
  const myCourseIds =
    ids === null ? null : validateIds(ids, new Set((await resolveScope(ctx)).courses.map((c) => c.id)));
  const next: UserSettings = { ...ctx.user.settings, myCourseIds };
  await ctx.store.updateSettings(ctx.user.id, next);
  ctx.user.settings = next;
  stateOf(ctx).scope = null;
  await ctx.store.audit({
    userId: ctx.user.id,
    at: nowMs(),
    actor: `mcp:${ctx.source}`,
    action: 'settings:my_courses',
    detail: { count: myCourseIds?.length ?? null },
  });
  return next;
}
