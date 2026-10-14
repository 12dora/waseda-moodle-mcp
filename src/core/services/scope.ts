/** "My courses": which enrolled courses count by default (confirmed selection, or an automatic suggestion). */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, MoodleError } from '../errors';
import { decodeEntities } from '../html';
import { fromTs, nowMs, nowSec } from '../time';
import type { Course, UserSettings } from '../types';
import { lookupTerms, termFit } from './syllabus';
import { requirePositiveInt } from './validate';

const TIMELINE_FN = 'core_course_get_enrolled_courses_by_timeline_classification';
const ENROL_FN = 'core_enrol_get_users_courses';
const EVENTS_FN = 'core_calendar_get_action_events_by_timesort';
const DAY_MS = 86_400_000;
const RECENT_ACCESS_MS = 21 * DAY_MS;
const EVENTS_HORIZON_SEC = 30 * 86_400;
const EVENTS_PAGE_SIZE = 50; // Moodle accepts 1..50

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

/** Courses with an action event in the next 30 days. Best effort: null when Moodle refuses the call. */
async function fetchEventCourses(api: MoodleApi): Promise<ReadonlySet<number> | null> {
  const from = nowSec();
  try {
    const res = await api.call<{ events?: Array<{ course?: { id?: number } | null }> }>(EVENTS_FN, {
      timesortfrom: from,
      timesortto: from + EVENTS_HORIZON_SEC,
      limitnum: EVENTS_PAGE_SIZE,
      limittononsuspendedevents: 1,
    });
    return new Set((res?.events ?? []).flatMap((e) => e.course?.id ?? []));
  } catch (e) {
    if (e instanceof MoodleError) return null;
    throw e;
  }
}

/** A course plus the academic year in its idnumber (null when it has none). */
interface Candidate {
  course: Course;
  year: number | null;
}

const idnumberYear = (idnumber: string | undefined): number | null => {
  const m = /^(\d{4})/.exec(idnumber ?? '');
  return m?.[1] ? Number(m[1]) : null;
};

const recentlyAccessed = (course: Course, now: number) =>
  course.lastAccess !== null && Date.parse(course.lastAccess) >= now - RECENT_ACCESS_MS;

/** Known term of another academic year -> 'not-current'; no term -> 'unknown'. */
const fitOf = ({ course, year }: Candidate, now: number) => termFit(course.term, now, year);

/**
 * class course AND (term is current in the course's academic year OR (term unknown AND (recent access OR calendar
 * event in the next 30 days))). A known, non-current term (e.g. 冬クォーター in October, or an old year's 秋クォーター)
 * is never suggested, even with recent access.
 */
function isSuggested(c: Candidate, now: number, eventCourses: ReadonlySet<number> | null): boolean {
  if (c.course.kind !== 'class') return false;
  const fit = fitOf(c, now);
  if (fit !== 'unknown') return fit === 'current';
  return recentlyAccessed(c.course, now) || eventCourses?.has(c.course.id) === true;
}

/** The calendar signal only matters for class courses the term and lastaccess rules leave undecided. */
const needsEventSignal = (candidates: Candidate[], now: number) =>
  candidates.some((c) => c.course.kind === 'class' && fitOf(c, now) === 'unknown' && !recentlyAccessed(c.course, now));

interface ScopeState {
  /** Kill switch for the public syllabus lookup (callers pass it from their env; the cron serves the cache only). */
  syllabusLookup: boolean;
  /** Whether the automatic suggestion may spend one calendar call on its event signal (not in the cron). */
  calendarSignal: boolean;
  scope: Promise<CourseScope> | null;
  terms: Promise<Map<number, string | null>> | null;
  /** ONE 30-day action-events call per request, shared by every tool that resolves the scope. */
  events: Promise<ReadonlySet<number> | null> | null;
}

const states = new WeakMap<ServiceContext, ScopeState>();

function stateOf(ctx: ServiceContext): ScopeState {
  let s = states.get(ctx);
  if (!s) {
    s = { syllabusLookup: ctx.syllabusLookup ?? true, calendarSignal: true, scope: null, terms: null, events: null };
    states.set(ctx, s);
  }
  return s;
}

async function lookupCourseTerms(ctx: ServiceContext, raw: RawCourse[], enabled: boolean) {
  const lookups = raw.map((c) => ({ id: Number(c.id ?? 0), idnumber: c.idnumber ?? '' }));
  const infos = await lookupTerms(ctx, lookups, { syllabusLookup: enabled });
  return new Map([...infos].map(([id, info]) => [id, info?.term ?? null]));
}

async function computeScope(ctx: ServiceContext, state: ScopeState): Promise<CourseScope> {
  const api = await ctx.moodle();
  const raw = await fetchRawCourses(api);
  state.terms ??= lookupCourseTerms(ctx, raw, state.syllabusLookup);
  const [access, terms] = await Promise.all([fetchLastAccess(api), state.terms]);
  const now = nowMs();
  const candidates = raw.map((r): Candidate => {
    const course = { ...mapCourse(r, api.baseUrl), lastAccess: fromTs(access.get(Number(r.id))) };
    return { course: { ...course, term: terms.get(course.id) ?? null }, year: idnumberYear(r.idnumber) };
  });
  if (state.calendarSignal && needsEventSignal(candidates, now)) state.events ??= fetchEventCourses(api);
  const eventCourses = (await state.events) ?? null;
  const confirmed = ctx.user.settings.myCourseIds;
  const courses = candidates.map((c) => {
    const suggested = isSuggested(c, now, eventCourses);
    return { ...c.course, suggested, mine: confirmed ? confirmed.includes(c.course.id) : suggested };
  });
  return { mode: confirmed ? 'mine' : 'auto', mine: new Set(courses.filter((c) => c.mine).map((c) => c.id)), courses };
}

/**
 * Memoised per ServiceContext (= per request); the options apply to the first resolution of a context.
 * `syllabusLookup: false` (env kill switch, scheduled sweep) stops the public syllabus fetches (cached rows still
 * answer); `calendarSignal: false` (scheduled sweep) skips the one 30-day events call of the automatic suggestion.
 */
export function resolveScope(
  ctx: ServiceContext,
  opts: { syllabusLookup?: boolean; calendarSignal?: boolean } = {},
): Promise<CourseScope> {
  const state = stateOf(ctx);
  if (state.scope === null) {
    state.syllabusLookup = opts.syllabusLookup ?? state.syllabusLookup;
    state.calendarSignal = opts.calendarSignal ?? state.calendarSignal;
  }
  state.scope ??= computeScope(ctx, state);
  return state.scope;
}

function validateIds(ids: number[], enrolled: ReadonlySet<number>): number[] {
  const unique = [...new Set(ids.map((id) => requirePositiveInt(id, 'course id')))];
  const unknown = unique.filter((id) => !enrolled.has(id));
  if (unknown.length) throw new InvalidInput(`Not enrolled in course(s): ${unknown.join(', ')}.`);
  return unique;
}

/** `null` returns to the automatic suggestion. Only changes our own filter, never Moodle. */
export async function setMyCourses(ctx: ServiceContext, ids: number[] | null): Promise<UserSettings> {
  if (ids?.length === 0) throw new InvalidInput('Select at least one course, or reset to the suggestion.');
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
