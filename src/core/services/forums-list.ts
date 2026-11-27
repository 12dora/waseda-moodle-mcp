/** Newest discussions across forums (listing and paging). */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, MoodleError, NotFound } from '../errors';
import { nowSec, toMs } from '../time';
import type { DiscussionList, DiscussionSummary, ForumListEntry, TruncatedForum } from '../types';
import { listCourses } from './courses';
import {
  type ForumRef,
  type ForumType,
  fetchDiscussions,
  fetchForums,
  fetchForumsOfTypes,
  forumReadCap,
  MAX_FORUMS_PER_CALL,
  nonEmptyForums,
  readEach,
  webCallsLeft,
} from './forums';
import { clampInt, courseNameMap, getCourseModule } from './shared';

/** Discussions read per forum when several forums are listed together. */
const PER_FORUM_WHEN_MANY = 10;

interface ForumSelection {
  refs: ForumRef[];
  names: Map<number, string>;
  /** Forums not looked at (the call budget ran out before their course). */
  skipped: number;
}

interface ListOptions {
  courseId?: number;
  forumCmid?: number;
  sinceDays?: number;
  limit?: number;
  page?: number;
}

interface ForumFetch {
  ref: ForumRef;
  discussions: DiscussionSummary[];
}

/** Course and forum type of a forum cmid; without a course hint the cmid is looked up. */
async function locateForum(
  api: MoodleApi,
  cmid: number,
  courseId?: number,
): Promise<{ course: number; types: ForumType[] }> {
  if (courseId != null) return { course: courseId, types: ['forum', 'hsuforum'] };
  const cm = await getCourseModule(api, cmid);
  if (cm.modname !== 'forum' && cm.modname !== 'hsuforum') throw new InvalidInput(`Activity ${cmid} is not a forum.`);
  return { course: cm.courseId, types: [cm.modname] };
}

async function selectByCmid(
  ctx: ServiceContext,
  api: MoodleApi,
  wanted: number,
  courseId?: number,
): Promise<ForumSelection> {
  const [where, names] = await Promise.all([locateForum(api, wanted, courseId), courseNameMap(ctx)]);
  const hint = { cmid: wanted };
  const refs = (await fetchForumsOfTypes(api, where.types, [where.course], hint)).filter((r) => r.cmid === wanted);
  if (refs.length === 0) throw new NotFound(`Forum ${wanted} was not found in this course.`);
  return { refs, names, skipped: 0 };
}

/** Recent activity first so the 15-forum cap keeps live discussion forums, not stale news. */
function byRecentActivity(a: ForumRef, b: ForumRef): number {
  return b.modifiedTs - a.modifiedTs || (b.numDiscussions ?? 0) - (a.numDiscussions ?? 0);
}

// ------------------------------------------------------------------ forums of courses

export interface ForumScope {
  refs: ForumRef[];
  /** Forums of courses left out for the call budget (counted from the course structure). */
  skipped: number;
  /** Web channel: cmids of each course's first section-0 forum, where Moodle puts the announcements forum. */
  likelyNews: Set<number>;
}

/** One course's forum activities from its structure; counts null when the structure could not be read. */
export interface CourseForums {
  courseId: number;
  forums: number | null;
  hsuforums: number | null;
  newsCmid: number | null;
}

interface StateCm {
  id?: string | number;
  module?: string;
  sectionnumber?: number;
  uservisible?: boolean;
}

/** The `cm` list of a `core_courseformat_get_state` answer (`data` is a JSON string); null when unreadable. */
function stateCms(state: unknown): StateCm[] | null {
  try {
    const parsed: unknown = typeof state === 'string' ? JSON.parse(state) : state;
    const cms = (parsed as { cm?: unknown } | null)?.cm;
    return Array.isArray(cms) ? (cms as StateCm[]) : null;
  } catch {
    return null;
  }
}

function courseForums(courseId: number, state: unknown): CourseForums {
  const cms = stateCms(state)?.filter((c) => c.uservisible !== false);
  if (!cms) return { courseId, forums: null, hsuforums: null, newsCmid: null };
  const newsCmid = Number(cms.find((c) => c.module === 'forum' && c.sectionnumber === 0)?.id);
  return {
    courseId,
    forums: cms.filter((c) => c.module === 'forum').length,
    hsuforums: cms.filter((c) => c.module === 'hsuforum').length,
    newsCmid: Number.isSafeInteger(newsCmid) && newsCmid > 0 ? newsCmid : null,
  };
}

/**
 * Which courses' forum lists to read within `left` requests, in course order: a course costs its forum overview
 * when it has forums and its hsuforum index when it has Advanced Forums (plus one shared course-structure batch for
 * their cmids); half of `left` (at most MAX_FORUMS_PER_CALL) stays for reading the forums.
 */
function planScope(courses: CourseForums[], left: number): { forum: number[]; hsuforum: number[]; skipped: number } {
  let budget = left - Math.min(MAX_FORUMS_PER_CALL, Math.floor(left / 2));
  const plan = { forum: [] as number[], hsuforum: [] as number[], skipped: 0 };
  for (const c of courses) {
    const forum = c.forums !== 0;
    const hsu = c.hsuforums !== 0;
    const cost = Number(forum) + (hsu ? 1 + Number(plan.hsuforum.length === 0) : 0);
    if (cost > budget) {
      plan.skipped += (c.forums ?? 0) + (c.hsuforums ?? 0);
      continue;
    }
    budget -= cost;
    if (forum) plan.forum.push(c.courseId);
    if (hsu) plan.hsuforum.push(c.courseId);
  }
  return plan;
}

const unreadable = (e: unknown) => {
  if (e instanceof MoodleError) return null;
  throw e;
};

/** Web channel: the forum activities of each course from its structure (one ajax batch for all courses). */
export async function courseStructures(api: MoodleApi, courseIds: number[]): Promise<CourseForums[]> {
  const states = await Promise.all(
    courseIds.map((courseid) => api.call<unknown>('core_courseformat_get_state', { courseid }).catch(unreadable)),
  );
  return courseIds.map((id, i) => courseForums(id, states[i]));
}

/** A course's counts with the types not asked for set to none. */
const onlyTypes = (c: CourseForums, types: ForumType[]): CourseForums => ({
  ...c,
  forums: types.includes('forum') ? c.forums : 0,
  hsuforums: types.includes('hsuforum') ? c.hsuforums : 0,
});

/** Which forum types to list; `structures`: the courses' structures when the caller has read them (web channel). */
interface ScopeOptions {
  types?: ForumType[];
  structures?: CourseForums[];
}

/**
 * Web channel: every forum list costs a page per course and type, so read the courses' structure first (one ajax
 * batch, unless given) and list only the types each course has, as far as the call budget allows.
 */
async function webScope(api: MoodleApi, courseIds: number[], opts: ScopeOptions): Promise<ForumScope> {
  const types = opts.types ?? ['forum', 'hsuforum'];
  const courses = (opts.structures ?? (await courseStructures(api, courseIds))).map((c) => onlyTypes(c, types));
  const plan = planScope(courses, webCallsLeft(api));
  const [forums, hsuforums] = await Promise.all([
    fetchForums(api, 'forum', plan.forum),
    fetchForums(api, 'hsuforum', plan.hsuforum),
  ]);
  const news = courses.flatMap((c) => (c.newsCmid === null ? [] : [c.newsCmid]));
  return { refs: [...forums, ...hsuforums], skipped: plan.skipped, likelyNews: new Set(news) };
}

/** Standard and/or Advanced Forums of the courses (see webScope for the web channel). */
export async function forumsInScope(api: MoodleApi, courseIds: number[], opts: ScopeOptions = {}): Promise<ForumScope> {
  if (api.channel === 'web' && courseIds.length > 0) return webScope(api, courseIds, opts);
  const refs = await fetchForumsOfTypes(api, opts.types ?? ['forum', 'hsuforum'], courseIds);
  return { refs, skipped: 0, likelyNews: new Set() };
}

async function selectByCourse(ctx: ServiceContext, api: MoodleApi, courseId: number): Promise<ForumSelection> {
  const [scope, names] = await Promise.all([forumsInScope(api, [courseId]), courseNameMap(ctx)]);
  return { refs: scope.refs.sort(byRecentActivity), names, skipped: scope.skipped };
}

/** Forums of the courses in the user's scope (announcements and discussion forums). */
async function selectCurrentCourses(ctx: ServiceContext, api: MoodleApi): Promise<ForumSelection> {
  const courses = await listCourses(ctx);
  const scope = await forumsInScope(
    api,
    courses.map((c) => c.id),
  );
  return {
    refs: scope.refs.sort(byRecentActivity),
    names: new Map(courses.map((c) => [c.id, c.name])),
    skipped: scope.skipped,
  };
}

function selectForums(ctx: ServiceContext, api: MoodleApi, opts: ListOptions): Promise<ForumSelection> {
  if (opts.forumCmid != null) return selectByCmid(ctx, api, opts.forumCmid, opts.courseId);
  if (opts.courseId != null) return selectByCourse(ctx, api, opts.courseId);
  return selectCurrentCourses(ctx, api);
}

function toListEntry(ref: ForumRef, courseName: string): ForumListEntry {
  return {
    forumType: ref.forumType,
    forumId: ref.forumId,
    forumCmid: ref.cmid,
    forumName: ref.name,
    forumKind: ref.kind,
    courseId: ref.courseId,
    courseName,
    canCreateDiscussions: ref.canCreateDiscussions,
    dueAt: ref.dueAt,
    cutoffAt: ref.cutoffAt,
    numDiscussions: ref.numDiscussions,
  };
}

const forumKey = (f: { forumType: string; forumId: number }) => `${f.forumType}:${f.forumId}`;

async function readForums(
  api: MoodleApi,
  selection: ForumSelection,
  opts: { limit: number; page: number; single: boolean },
): Promise<{ fetches: ForumFetch[]; skipped: number; perForum: number; page: number }> {
  const page = opts.single ? opts.page : 0;
  const many = !opts.single && nonEmptyForums(selection.refs).length > 1;
  const perForum = many ? Math.min(opts.limit, PER_FORUM_WHEN_MANY) : opts.limit;
  const read = async (ref: ForumRef): Promise<ForumFetch[]> => {
    const name = selection.names.get(ref.courseId) ?? `Course ${ref.courseId}`;
    const discussions = await fetchDiscussions(api, ref, name, { limit: perForum, page });
    return [{ ref, discussions }];
  };
  const { items: fetches, skipped } = await readEach(selection.refs, read, forumReadCap(api));
  return { fetches, skipped, perForum, page };
}

function remainingAfter(ref: ForumRef, page: number, perForum: number, nShown: number): number | null {
  return ref.numDiscussions != null ? Math.max(0, ref.numDiscussions - page * perForum - nShown) : null;
}

function serverHasMore(ref: ForumRef, nFetched: number, perForum: number, page: number): boolean {
  return nFetched >= perForum && (ref.numDiscussions == null || page * perForum + nFetched < ref.numDiscussions);
}

function truncationOf(args: {
  ref: ForumRef;
  nFetched: number;
  nShown: number;
  perForum: number;
  page: number;
  single: boolean;
}): TruncatedForum | null {
  const { ref, nFetched, nShown, perForum, page, single } = args;
  if (nShown === 0 && (single || nFetched === 0)) return null;
  const partial = nShown < nFetched;
  if (!partial && !serverHasMore(ref, nFetched, perForum, page)) return null;
  return {
    forumType: ref.forumType,
    forumId: ref.forumId,
    forumCmid: ref.cmid,
    forumName: ref.name,
    remaining: remainingAfter(ref, page, perForum, nShown),
    nextPage: partial ? page : page + 1,
    pageSize: perForum,
  };
}

function countShownByForum(shown: DiscussionSummary[]): Map<string, number> {
  const shownByForum = new Map<string, number>();
  for (const d of shown) shownByForum.set(forumKey(d), (shownByForum.get(forumKey(d)) ?? 0) + 1);
  return shownByForum;
}

/** Continuation after the final result limit, using how many discussions of each forum were actually returned. */
function truncations(args: {
  fetches: ForumFetch[];
  shown: DiscussionSummary[];
  perForum: number;
  page: number;
  single: boolean;
}): TruncatedForum[] {
  const shownByForum = countShownByForum(args.shown);
  const out: TruncatedForum[] = [];
  for (const { ref, discussions } of args.fetches) {
    const cut = truncationOf({
      ref,
      nFetched: discussions.length,
      nShown: shownByForum.get(forumKey(ref)) ?? 0,
      perForum: args.perForum,
      page: args.page,
      single: args.single,
    });
    if (cut) out.push(cut);
  }
  return out;
}

const modifiedMs = (d: DiscussionSummary) => (d.modifiedAt ? toMs(d.modifiedAt) : 0);

/**
 * Newest discussions across forums. Without ids: forums of the user's current courses, recent activity first.
 * With several forums only the 10 most recent discussions of each are read (pinned ones first, as Moodle orders them).
 * `page` applies only when listing one forum.
 */
export async function listDiscussions(ctx: ServiceContext, opts: ListOptions = {}): Promise<DiscussionList> {
  const limit = clampInt(opts.limit, 20, 1, 50);
  const page = clampInt(opts.page, 0, 0, 100);
  if (page > 0 && opts.forumCmid == null) {
    throw new InvalidInput('page is for one forum; pass forum_cmid.');
  }
  const api = await ctx.moodle();
  const selection = await selectForums(ctx, api, opts);
  const single = opts.forumCmid != null;
  const { fetches, skipped, perForum, page: fetchPage } = await readForums(api, selection, { limit, page, single });
  const cutoff = opts.sinceDays != null && opts.sinceDays > 0 ? (nowSec() - opts.sinceDays * 86400) * 1000 : 0;
  const recent = cutoff
    ? fetches.flatMap((f) => f.discussions).filter((d) => modifiedMs(d) >= cutoff)
    : fetches.flatMap((f) => f.discussions);
  recent.sort((a, b) => modifiedMs(b) - modifiedMs(a) || b.discussionId - a.discussionId);
  const shown = recent.slice(0, limit);
  const listedRefs = single ? selection.refs : nonEmptyForums(selection.refs).slice(0, MAX_FORUMS_PER_CALL);
  return {
    forums: listedRefs.map((ref) => toListEntry(ref, selection.names.get(ref.courseId) ?? `Course ${ref.courseId}`)),
    discussions: shown,
    skippedForums: skipped + selection.skipped,
    truncatedForums: truncations({ fetches, shown, perForum, page: fetchPage, single }),
  };
}
