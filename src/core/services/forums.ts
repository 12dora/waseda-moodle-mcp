/** Forum discussions (mod_forum and Open LMS mod_hsuforum). */

import type { CallHint, MoodleApi, ServiceContext } from '../context';
import { InvalidInput, MoodleError, NotFound } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import { fromTs } from '../time';
import type { Discussion, DiscussionSummary, IsoJst } from '../types';
import { loadPosts, type MappedPosts } from './forums-posts';
import { courseNameMap, getCourseModule, pickLang } from './shared';

export type { RawForumPosts, RawHsuPosts } from './forums-posts';

export type ForumType = 'forum' | 'hsuforum';

/** Most forums read in one call (each costs one Moodle request). */
export const MAX_FORUMS_PER_CALL = 15;
/** Web channel: Moodle requests a forum listing or search may spend of the client's 40 (a page or ajax POST each). */
const WEB_CALLS = 36;
/** Moodle `mod_forum_get_forum_discussions` sortorder: last post, newest first. */
const LASTPOST_DESC = 1;
const INTRO_MAX_CHARS = 600;

// ------------------------------------------------------------------ raw Moodle shapes (loose)

export interface RawForum {
  id: number;
  course: number;
  cmid?: number | null;
  type?: string | null;
  name?: string | null;
  intro?: string | null;
  duedate?: number | null;
  cutoffdate?: number | null;
  cancreatediscussions?: boolean | null;
  timemodified?: number | null;
  anonymous?: boolean | number | null;
  numdiscussions?: number | null;
  istracked?: boolean | null;
}

export interface RawDiscussion {
  id: number | null; // first post id (null on the web channel when the list does not show it)
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
  warnings?: { message?: string | null }[] | null;
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
  cutoffAt: IsoJst | null;
  canCreateDiscussions: boolean;
  modifiedTs: number; // forum.timemodified, 0 if unknown
  anonymous: boolean;
  numDiscussions: number | null;
  /** Unread tracking is on for the user (null = unknown). */
  tracked: boolean | null;
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
    cutoffAt: fromTs(raw.cutoffdate),
    canCreateDiscussions: raw.cancreatediscussions === true,
    modifiedTs: typeof raw.timemodified === 'number' ? raw.timemodified : 0,
    anonymous: raw.anonymous === true || raw.anonymous === 1,
    numDiscussions: typeof raw.numdiscussions === 'number' ? raw.numdiscussions : null,
    tracked: typeof raw.istracked === 'boolean' ? raw.istracked : null,
  };
}

/**
 * Forums of the given courses. hsuforum may be unavailable/forbidden -> []. Never queries with an empty id list (= all
 * enrolled). `hint.cmid`: only that forum is wanted (the web channel then reads just its page).
 */
export async function fetchForums(
  api: MoodleApi,
  forumType: ForumType,
  courseIds: number[],
  hint?: CallHint,
): Promise<ForumRef[]> {
  if (courseIds.length === 0) return [];
  let list: RawForum[] | null | undefined;
  try {
    list = await api.call<RawForum[]>(`mod_${forumType}_get_forums_by_courses`, { courseids: courseIds }, hint);
  } catch (e) {
    if (forumType === 'hsuforum' && e instanceof MoodleError) return [];
    throw e;
  }
  return Array.isArray(list) ? list.map((f) => mapForumRef(f, forumType)) : [];
}

export async function fetchForumsOfTypes(
  api: MoodleApi,
  types: ForumType[],
  courseIds: number[],
  hint?: CallHint,
): Promise<ForumRef[]> {
  const lists = await Promise.all(types.map((t) => fetchForums(api, t, courseIds, hint)));
  return lists.flat();
}

// ------------------------------------------------------------------ discussions

function toInt(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function forumFields(
  ref: ForumRef | null,
): Pick<DiscussionSummary, 'forumKind' | 'canCreateDiscussions' | 'dueAt' | 'cutoffAt'> {
  return {
    forumKind: ref?.kind ?? 'general',
    canCreateDiscussions: ref?.canCreateDiscussions === true,
    dueAt: ref?.dueAt ?? null,
    cutoffAt: ref?.cutoffAt ?? null,
  };
}

export function mapDiscussion(raw: RawDiscussion, ref: ForumRef, courseName: string): DiscussionSummary {
  return {
    forumType: ref.forumType,
    forumId: ref.forumId,
    forumCmid: ref.cmid,
    forumName: ref.name,
    courseId: ref.courseId,
    courseName,
    discussionId: raw.discussion ?? raw.id ?? 0,
    firstPostId: raw.id ?? 0,
    subject: decodeEntities(raw.subject || raw.name || ''),
    author: decodeEntities(raw.userfullname ?? ''),
    createdAt: fromTs(raw.created),
    modifiedAt: fromTs(raw.timemodified || raw.modified || raw.created),
    replies: toInt(raw.numreplies),
    unread: typeof raw.numunread === 'number' ? raw.numunread : null,
    pinned: raw.pinned === true,
    ...forumFields(ref),
  };
}

/** Paginated hsuforum returns [] + this warning for anonymous forums; the other function still lists them. */
function hsuAnonymousWarning(res: RawDiscussionList | null | undefined): boolean {
  return (res?.warnings ?? [])
    .map((w) => w.message ?? '')
    .join(' ')
    .toLowerCase()
    .includes('anonymous');
}

/** `mod_hsuforum_get_forum_discussions` accepts page/perpage (Open LMS externallib.php). */
async function fetchHsuDiscussions(
  api: MoodleApi,
  ref: ForumRef,
  limit: number,
  page: number,
): Promise<RawDiscussion[]> {
  const res = await api.call<RawDiscussionList>('mod_hsuforum_get_forum_discussions', {
    forumid: ref.forumId,
    sortorder: LASTPOST_DESC,
    page,
    perpage: limit,
  });
  return res?.discussions ?? [];
}

/**
 * Latest raw discussions of one forum. Anonymous hsuforum uses `mod_hsuforum_get_forum_discussions`
 * (paginated returns nothing); that function is paged server-side. Moodle lists pinned first, then by
 * last post, so a small `limit` can be filled by pinned ones; callers that merge forums re-sort by
 * modification time. `messages`: the web channel reads the first posts too (one more request; it marks them read
 * on tracked forums) — the web service always includes them; without it `message` is null on the web channel.
 */
export async function fetchRawDiscussions(
  api: MoodleApi,
  ref: ForumRef,
  opts: { limit: number; page?: number; messages?: boolean },
): Promise<RawDiscussion[]> {
  const { limit, page = 0 } = opts;
  if (ref.forumType === 'forum') {
    const params = { forumid: ref.forumId, sortorder: LASTPOST_DESC, page, perpage: limit };
    const hint = opts.messages ? { messages: true } : undefined;
    const res = await api.call<RawDiscussionList>('mod_forum_get_forum_discussions', params, hint);
    return res?.discussions ?? [];
  }
  if (ref.anonymous) return fetchHsuDiscussions(api, ref, limit, page);
  const res = await api.call<RawDiscussionList>('mod_hsuforum_get_forum_discussions_paginated', {
    forumid: ref.forumId,
    sortby: 'timemodified',
    sortdirection: 'DESC',
    page,
    perpage: limit,
  });
  if ((res?.discussions ?? []).length === 0 && hsuAnonymousWarning(res)) {
    return fetchHsuDiscussions(api, ref, limit, page);
  }
  return res?.discussions ?? [];
}

export async function fetchDiscussions(
  api: MoodleApi,
  ref: ForumRef,
  courseName: string,
  opts: { limit: number; page?: number },
): Promise<DiscussionSummary[]> {
  return (await fetchRawDiscussions(api, ref, opts)).map((d) => mapDiscussion(d, ref, courseName));
}

/** Forums worth a Moodle call: those known to be empty cost nothing. */
export const nonEmptyForums = (refs: ForumRef[]) => refs.filter((r) => r.numDiscussions !== 0);

/** Web channel: requests left of WEB_CALLS for this listing or search; unbounded on the web service. */
export const webCallsLeft = (api: MoodleApi) =>
  api.channel === 'web' ? Math.max(0, WEB_CALLS - api.callsMade) : Number.POSITIVE_INFINITY;

/** How many forums readEach may read now (one request each). */
export const forumReadCap = (api: MoodleApi) => Math.min(MAX_FORUMS_PER_CALL, webCallsLeft(api));

/**
 * Runs `read` for up to `cap` (≤ MAX_FORUMS_PER_CALL) forums in parallel (one Moodle call each); forums that cannot
 * be read (no permission, ...) and those over the cap count as skipped.
 */
export async function readEach<T>(
  refs: ForumRef[],
  read: (ref: ForumRef) => Promise<T[]>,
  cap = MAX_FORUMS_PER_CALL,
): Promise<{ items: T[]; skipped: number }> {
  const nonEmpty = nonEmptyForums(refs);
  const candidates = nonEmpty.slice(0, Math.min(cap, MAX_FORUMS_PER_CALL));
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
    ...forumFields(ref),
  };
}

async function discussionIdFromPost(api: MoodleApi, postId: number): Promise<number | null> {
  try {
    const res = await api.call<{ post?: { discussionid?: number | null } | null }>('mod_forum_get_discussion_post', {
      postid: postId,
    });
    const id = res?.post?.discussionid;
    return typeof id === 'number' && id > 0 ? id : null;
  } catch (e) {
    if (e instanceof MoodleError) return null;
    throw e;
  }
}

async function loadDiscussionPosts(
  api: MoodleApi,
  forumType: ForumType,
  discussionId: number,
): Promise<{ mapped: MappedPosts; forumId?: number; courseId?: number }> {
  try {
    return await loadPosts(api, forumType, discussionId);
  } catch (e) {
    if (!(e instanceof NotFound)) throw e;
    if (forumType === 'forum') {
      const real = await discussionIdFromPost(api, discussionId);
      if (real != null && real !== discussionId) {
        throw new InvalidInput(`${discussionId} is a post id. Use discussion_id ${real} from list_discussions.`);
      }
    }
    throw e;
  }
}

function postsForId(posts: MappedPosts['posts'], discussionId: number, postId?: number): MappedPosts['posts'] {
  if (postId == null) return posts;
  const target = posts.find((p) => p.id === postId);
  if (!target) throw new NotFound(`Post ${postId} is not in discussion ${discussionId}.`);
  const parent = target.parentId != null ? posts.find((p) => p.id === target.parentId) : undefined;
  return parent && parent.id !== target.id ? [parent, target] : [target];
}

/**
 * All posts of one discussion, oldest first (or one post and its parent when `postId` is set).
 * mod_hsuforum returns neither forum nor course for a discussion; pass `forumCmid` (from list_discussions)
 * to fill the summary's forum/course fields, otherwise they stay 0 / "".
 */
export async function getDiscussion(
  ctx: ServiceContext,
  opts: { forumType: ForumType; discussionId: number; forumCmid?: number; postId?: number },
): Promise<Discussion> {
  const api = await ctx.moodle();
  const { forumType, discussionId, forumCmid, postId } = opts;
  const { mapped, forumId, courseId: postCourseId } = await loadDiscussionPosts(api, forumType, discussionId);
  if (mapped.posts.length === 0) throw new NotFound(`Discussion ${discussionId} has no readable posts.`);

  const courseId = postCourseId ?? (forumCmid != null ? (await getCourseModule(api, forumCmid)).courseId : undefined);
  let ref: ForumRef | null = null;
  let courseName = '';
  if (courseId != null) {
    const hint = forumCmid != null ? { cmid: forumCmid } : undefined;
    const [forums, names] = await Promise.all([fetchForums(api, forumType, [courseId], hint), courseNameMap(ctx)]);
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
  const posts = postsForId(mapped.posts, discussionId, postId);
  const canReply = postId != null ? (posts.at(-1)?.canReply ?? false) : mapped.canReply;
  const forumIntro = ref ? htmlToMarkdown(pickLang(ref.intro, ctx.user.lang), { maxChars: INTRO_MAX_CHARS }) : '';
  return { summary, posts, canReply, forumIntro };
}
