/** Newest discussions across forums (listing and paging). */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, NotFound } from '../errors';
import { nowSec, toMs } from '../time';
import type { DiscussionList, DiscussionSummary, ForumListEntry, TruncatedForum } from '../types';
import { listCourses } from './courses';
import {
  type ForumRef,
  type ForumType,
  fetchDiscussions,
  fetchForumsOfTypes,
  MAX_FORUMS_PER_CALL,
  readEach,
} from './forums';
import { clampInt, courseNameMap, getCourseModule } from './shared';

/** Discussions read per forum when several forums are listed together. */
const PER_FORUM_WHEN_MANY = 10;

interface ForumSelection {
  refs: ForumRef[];
  names: Map<number, string>;
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
  const refs = (await fetchForumsOfTypes(api, where.types, [where.course])).filter((r) => r.cmid === wanted);
  if (refs.length === 0) throw new NotFound(`Forum ${wanted} was not found in this course.`);
  return { refs, names };
}

/** Recent activity first so the 15-forum cap keeps live discussion forums, not stale news. */
function byRecentActivity(a: ForumRef, b: ForumRef): number {
  return b.modifiedTs - a.modifiedTs || (b.numDiscussions ?? 0) - (a.numDiscussions ?? 0);
}

async function selectByCourse(ctx: ServiceContext, api: MoodleApi, courseId: number): Promise<ForumSelection> {
  const [refs, names] = await Promise.all([
    fetchForumsOfTypes(api, ['forum', 'hsuforum'], [courseId]),
    courseNameMap(ctx),
  ]);
  return { refs: refs.sort(byRecentActivity), names };
}

/** Forums of the courses in the user's scope (announcements and discussion forums). */
async function selectCurrentCourses(ctx: ServiceContext, api: MoodleApi): Promise<ForumSelection> {
  const courses = await listCourses(ctx);
  const all = await fetchForumsOfTypes(
    api,
    ['forum', 'hsuforum'],
    courses.map((c) => c.id),
  );
  return { refs: all.sort(byRecentActivity), names: new Map(courses.map((c) => [c.id, c.name])) };
}

function selectForums(ctx: ServiceContext, api: MoodleApi, opts: ListOptions): Promise<ForumSelection> {
  if (opts.forumCmid != null) return selectByCmid(ctx, api, opts.forumCmid, opts.courseId);
  if (opts.courseId != null) return selectByCourse(ctx, api, opts.courseId);
  return selectCurrentCourses(ctx, api);
}

/** Forums worth a Moodle call: those known to be empty cost nothing. */
const nonEmpty = (refs: ForumRef[]) => refs.filter((r) => r.numDiscussions !== 0);

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
  const many = !opts.single && nonEmpty(selection.refs).length > 1;
  const perForum = many ? Math.min(opts.limit, PER_FORUM_WHEN_MANY) : opts.limit;
  const { items: fetches, skipped } = await readEach(selection.refs, async (ref) => {
    const name = selection.names.get(ref.courseId) ?? `Course ${ref.courseId}`;
    const discussions = await fetchDiscussions(api, ref, name, { limit: perForum, page });
    return [{ ref, discussions }];
  });
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
  const listedRefs = single ? selection.refs : nonEmpty(selection.refs).slice(0, MAX_FORUMS_PER_CALL);
  return {
    forums: listedRefs.map((ref) => toListEntry(ref, selection.names.get(ref.courseId) ?? `Course ${ref.courseId}`)),
    discussions: shown,
    skippedForums: skipped,
    truncatedForums: truncations({ fetches, shown, perForum, page: fetchPage, single }),
  };
}
