/** Forum discussions (mod_forum and Open LMS mod_hsuforum). */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, MoodleError, NotFound } from '../errors';
import { decodeEntities } from '../html';
import { fromTs, nowSec, toMs } from '../time';
import type { Discussion, DiscussionSummary, IsoJst } from '../types';
import { listCourses } from './courses';
import { loadPosts, type MappedPosts } from './forums-posts';
import { clampInt, courseNameMap, getCourseModule } from './shared';

export type { RawForumPosts, RawHsuPosts } from './forums-posts';

export type ForumType = 'forum' | 'hsuforum';

/** Most forums read in one call (each costs one Moodle request). */
const MAX_FORUMS_PER_CALL = 15;
/** Discussions read per forum when several forums are listed together. */
const PER_FORUM_WHEN_MANY = 10;

// ------------------------------------------------------------------ raw Moodle shapes (loose)

export interface RawForum {
  id: number;
  course: number;
  cmid?: number | null;
  type?: string | null;
  name?: string | null;
  intro?: string | null;
  duedate?: number | null;
  numdiscussions?: number | null;
}

export interface RawDiscussion {
  id: number; // first post id
  discussion?: number | null; // discussion id
  name?: string | null;
  subject?: string | null;
  message?: string | null; // first post, HTML
  userid?: number | null; // author
  userfullname?: string | null;
  created?: number | null;
  modified?: number | null;
  timemodified?: number | null;
  numreplies?: number | string | null;
  numunread?: number | null;
  pinned?: boolean | null;
}

export interface RawDiscussionList {
  discussions?: RawDiscussion[] | null;
}

// ------------------------------------------------------------------ forum lookup

export interface ForumRef {
  forumType: ForumType;
  forumId: number;
  cmid: number | null;
  courseId: number;
  name: string;
  kind: string; // forum `type` (news, general, qanda, …)
  intro: string; // raw HTML
  dueAt: IsoJst | null;
  numDiscussions: number | null;
}

export function mapForumRef(raw: RawForum, forumType: ForumType): ForumRef {
  return {
    forumType,
    forumId: raw.id,
    cmid: raw.cmid ?? null,
    courseId: raw.course,
    name: decodeEntities(raw.name ?? ''),
    kind: raw.type ?? 'general',
    intro: raw.intro ?? '',
    dueAt: fromTs(raw.duedate),
    numDiscussions: typeof raw.numdiscussions === 'number' ? raw.numdiscussions : null,
  };
}

/** Forums of the given courses. hsuforum may be unavailable/forbidden -> []. Never queries with an empty id list (= all enrolled). */
export async function fetchForums(api: MoodleApi, forumType: ForumType, courseIds: number[]): Promise<ForumRef[]> {
  if (courseIds.length === 0) return [];
  let list: RawForum[] | null | undefined;
  try {
    list = await api.call<RawForum[]>(`mod_${forumType}_get_forums_by_courses`, { courseids: courseIds });
  } catch (e) {
    if (forumType === 'hsuforum' && e instanceof MoodleError) return [];
    throw e;
  }
  return Array.isArray(list) ? list.map((f) => mapForumRef(f, forumType)) : [];
}

export async function fetchForumsOfTypes(api: MoodleApi, types: ForumType[], courseIds: number[]): Promise<ForumRef[]> {
  const lists = await Promise.all(types.map((t) => fetchForums(api, t, courseIds)));
  return lists.flat();
}

// ------------------------------------------------------------------ discussions

function toInt(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

export function mapDiscussion(raw: RawDiscussion, ref: ForumRef, courseName: string): DiscussionSummary {
  return {
    forumType: ref.forumType,
    forumId: ref.forumId,
    forumCmid: ref.cmid,
    forumName: ref.name,
    courseId: ref.courseId,
    courseName,
    discussionId: raw.discussion ?? raw.id,
    firstPostId: raw.id,
    subject: decodeEntities(raw.subject || raw.name || ''),
    author: decodeEntities(raw.userfullname ?? ''),
    createdAt: fromTs(raw.created),
    modifiedAt: fromTs(raw.timemodified || raw.modified || raw.created),
    replies: toInt(raw.numreplies),
    unread: typeof raw.numunread === 'number' ? raw.numunread : null,
    pinned: raw.pinned === true,
  };
}

/**
 * Latest raw discussions of one forum, one Moodle call. Moodle lists pinned discussions first, then by last post,
 * so a small `limit` can be filled by pinned ones; callers that merge forums re-sort by modification time.
 */
export async function fetchRawDiscussions(api: MoodleApi, ref: ForumRef, limit: number): Promise<RawDiscussion[]> {
  const res =
    ref.forumType === 'forum'
      ? await api.call<RawDiscussionList>('mod_forum_get_forum_discussions', {
          forumid: ref.forumId,
          sortorder: -1,
          page: 0,
          perpage: limit,
        })
      : await api.call<RawDiscussionList>('mod_hsuforum_get_forum_discussions_paginated', {
          forumid: ref.forumId,
          sortby: 'timemodified',
          sortdirection: 'DESC',
          page: 0,
          perpage: limit,
        });
  return res?.discussions ?? [];
}

export async function fetchDiscussions(
  api: MoodleApi,
  ref: ForumRef,
  courseName: string,
  limit: number,
): Promise<DiscussionSummary[]> {
  return (await fetchRawDiscussions(api, ref, limit)).map((d) => mapDiscussion(d, ref, courseName));
}

interface ForumSelection {
  refs: ForumRef[];
  names: Map<number, string>;
}

interface ListOptions {
  courseId?: number;
  forumCmid?: number;
  sinceDays?: number;
  limit?: number;
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

async function selectByCourse(ctx: ServiceContext, api: MoodleApi, courseId: number): Promise<ForumSelection> {
  const [refs, names] = await Promise.all([
    fetchForumsOfTypes(api, ['forum', 'hsuforum'], [courseId]),
    courseNameMap(ctx),
  ]);
  // announcements first, so the per-call cap never drops them
  return { refs: refs.sort((a, b) => Number(b.kind === 'news') - Number(a.kind === 'news')), names };
}

/** Announcement forums of the courses in the user's scope. */
async function selectAnnouncements(ctx: ServiceContext, api: MoodleApi): Promise<ForumSelection> {
  const courses = await listCourses(ctx);
  const all = await fetchForumsOfTypes(
    api,
    ['forum', 'hsuforum'],
    courses.map((c) => c.id),
  );
  return { refs: all.filter((r) => r.kind === 'news'), names: new Map(courses.map((c) => [c.id, c.name])) };
}

function selectForums(ctx: ServiceContext, api: MoodleApi, opts: ListOptions): Promise<ForumSelection> {
  if (opts.forumCmid != null) return selectByCmid(ctx, api, opts.forumCmid, opts.courseId);
  if (opts.courseId != null) return selectByCourse(ctx, api, opts.courseId);
  return selectAnnouncements(ctx, api);
}

/** Forums worth a Moodle call: those known to be empty cost nothing. */
const nonEmptyForums = (refs: ForumRef[]) => refs.filter((r) => r.numDiscussions !== 0);

/**
 * Runs `read` for up to MAX_FORUMS_PER_CALL forums in parallel (one Moodle call each); forums that cannot be read
 * (no permission, ...) and those over the cap count as skipped.
 */
export async function readEach<T>(
  refs: ForumRef[],
  read: (ref: ForumRef) => Promise<T[]>,
): Promise<{ items: T[]; skipped: number }> {
  const nonEmpty = nonEmptyForums(refs);
  const candidates = nonEmpty.slice(0, MAX_FORUMS_PER_CALL);
  let skipped = nonEmpty.length - candidates.length;
  const lists = await Promise.all(
    candidates.map(async (ref) => {
      try {
        return await read(ref);
      } catch (e) {
        if (!(e instanceof MoodleError)) throw e;
        skipped++;
        return [];
      }
    }),
  );
  return { items: lists.flat(), skipped };
}

async function readForums(
  api: MoodleApi,
  selection: ForumSelection,
  limit: number,
): Promise<{ discussions: DiscussionSummary[]; skipped: number }> {
  const perForum = nonEmptyForums(selection.refs).length > 1 ? Math.min(limit, PER_FORUM_WHEN_MANY) : limit;
  const { items, skipped } = await readEach(selection.refs, (ref) =>
    fetchDiscussions(api, ref, selection.names.get(ref.courseId) ?? `Course ${ref.courseId}`, perForum),
  );
  return { discussions: items, skipped };
}

const modifiedMs = (d: DiscussionSummary) => (d.modifiedAt ? toMs(d.modifiedAt) : 0);

/**
 * Newest discussions across forums. Without ids: announcement forums of in-progress courses. With several forums
 * only the 10 most recent discussions of each are read (pinned ones first, as Moodle orders them).
 */
export async function listDiscussions(
  ctx: ServiceContext,
  opts: ListOptions = {},
): Promise<{ discussions: DiscussionSummary[]; skippedForums: number }> {
  const limit = clampInt(opts.limit, 20, 1, 50);
  const api = await ctx.moodle();
  const { discussions, skipped } = await readForums(api, await selectForums(ctx, api, opts), limit);
  const cutoff = opts.sinceDays != null && opts.sinceDays > 0 ? (nowSec() - opts.sinceDays * 86400) * 1000 : 0;
  const recent = cutoff ? discussions.filter((d) => modifiedMs(d) >= cutoff) : discussions;
  recent.sort((a, b) => modifiedMs(b) - modifiedMs(a));
  return { discussions: recent.slice(0, limit), skippedForums: skipped };
}

/** Summary rebuilt from the posts; `ref` fills the forum and course fields when the forum could be resolved. */
function summaryFromPosts(args: {
  discussionId: number;
  forumType: ForumType;
  mapped: MappedPosts;
  ref: ForumRef | null;
  course: { id: number; name: string };
  forumId: number;
}): DiscussionSummary {
  const { mapped, ref } = args;
  const root = mapped.posts.find((p) => p.parentId == null) ?? mapped.posts[0];
  return {
    forumType: args.forumType,
    forumId: ref?.forumId ?? args.forumId,
    forumCmid: ref?.cmid ?? null,
    forumName: ref?.name ?? '',
    courseId: ref?.courseId ?? args.course.id,
    courseName: args.course.name,
    discussionId: args.discussionId,
    firstPostId: root?.id ?? 0,
    subject: root?.subject ?? '',
    author: root?.author ?? '',
    createdAt: root?.createdAt ?? null,
    modifiedAt: mapped.modified,
    replies: Math.max(0, mapped.posts.length - 1),
    unread: mapped.unread,
    pinned: false,
  };
}

/**
 * All posts of one discussion, oldest first.
 * mod_hsuforum returns neither forum nor course for a discussion; pass `forumCmid` (from list_discussions)
 * to fill the summary's forum/course fields, otherwise they stay 0 / "".
 */
export async function getDiscussion(
  ctx: ServiceContext,
  opts: { forumType: ForumType; discussionId: number; forumCmid?: number },
): Promise<Discussion> {
  const api = await ctx.moodle();
  const { forumType, discussionId, forumCmid } = opts;
  const { mapped, forumId, courseId: postCourseId } = await loadPosts(api, forumType, discussionId);
  if (mapped.posts.length === 0) throw new NotFound(`Discussion ${discussionId} has no readable posts.`);

  const courseId = postCourseId ?? (forumCmid != null ? (await getCourseModule(api, forumCmid)).courseId : undefined);
  let ref: ForumRef | null = null;
  let courseName = '';
  if (courseId != null) {
    const [forums, names] = await Promise.all([fetchForums(api, forumType, [courseId]), courseNameMap(ctx)]);
    ref = forums.find((f) => (forumId != null ? f.forumId === forumId : f.cmid === forumCmid)) ?? null;
    courseName = names.get(courseId) ?? `Course ${courseId}`;
  }
  const summary = summaryFromPosts({
    discussionId,
    forumType,
    mapped,
    ref,
    course: { id: courseId ?? 0, name: courseName },
    forumId: forumId ?? 0,
  });
  return { summary, posts: mapped.posts, canReply: mapped.canReply };
}
