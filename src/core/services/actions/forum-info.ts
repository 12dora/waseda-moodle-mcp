/**
 * Read-side lookups the forum write actions share: forum settings and provenance, discussions, posts, posting window,
 * attachment permission and staging. Nothing here may change Moodle state: `mod_forum_get_discussion_posts` marks
 * the posts it returns as read on tracked forums with automatic marking, so prepare only calls it when that changes
 * nothing.
 */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput, NotFound } from '../../errors';
import { decodeEntities } from '../../html';
import { fmtDue, fromTs, toMs } from '../../time';
import type { FileRef, InlineFile, IsoJst } from '../../types';
import type { ForumType } from '../forums';
import { getCourseModule, mapFiles, type RawFile } from '../shared';
import { checkFileList, claimUpload, copyIntoDraft, gatherFiles, perFileLimit, uploadInline } from './drafts';
import type { FileInfo } from './inline-files';
import { isRec, num, type Raw, str, tryCall } from './shared';

export interface ForumSettings {
  forumType: ForumType;
  forumId: number;
  cmid: number | null;
  courseId: number;
  name: string | null;
  /** Moodle forum type: news, general, qanda, blog, … */
  kind: string | null;
  dueAt: IsoJst | null;
  cutoffAt: IsoJst | null;
  /** 0 = no attachments. */
  maxAttachments: number | null;
  /** 0 = the course / site limit, 1 = no attachments. */
  maxBytes: number | null;
  tracked: boolean | null;
  /** 0 optional, 1 forced, 2 auto, 3 disabled. */
  forceSubscribe: number | null;
}

export const decoded = (v: unknown): string | null => {
  const text = str(v);
  return text ? decodeEntities(text) : null;
};

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** One forum's settings from `mod_*_get_forums_by_courses`; null when Moodle does not list it. */
export async function readForumSettings(
  api: MoodleApi,
  forumType: ForumType,
  courseId: number,
  forumId: number,
): Promise<ForumSettings | null> {
  const list = await tryCall<unknown>(api, `mod_${forumType}_get_forums_by_courses`, { courseids: [courseId] });
  const f = Array.isArray(list) ? list.find((x): x is Raw => isRec(x) && num(x.id) === forumId) : undefined;
  if (!f) return null;
  return {
    forumType,
    forumId,
    cmid: num(f.cmid),
    courseId,
    name: decoded(f.name),
    kind: str(f.type),
    dueAt: fromTs(num(f.duedate)),
    cutoffAt: fromTs(num(f.cutoffdate)),
    maxAttachments: num(f.maxattachments),
    maxBytes: num(f.maxbytes),
    tracked: bool(f.istracked),
    forceSubscribe: num(f.forcesubscribe),
  };
}

/** Throws once the cut-off has passed; otherwise the due / cut-off lines for the preview and a late warning. */
export function postingWindow(s: ForumSettings | null, now: number): { details: string[]; warnings: string[] } {
  if (s?.cutoffAt && now > toMs(s.cutoffAt)) {
    throw new InvalidInput(`This forum stopped accepting posts at ${fmtDue(s.cutoffAt)} (JST).`);
  }
  const details: string[] = [];
  const warnings: string[] = [];
  if (s?.dueAt) {
    details.push(`Due: ${fmtDue(s.dueAt)}`);
    if (now > toMs(s.dueAt)) warnings.push(`The due date (${fmtDue(s.dueAt)}) has passed; the post will be late.`);
  }
  if (s?.cutoffAt) details.push(`Posting closes: ${fmtDue(s.cutoffAt)}`);
  return { details, warnings };
}

// ------------------------------------------------------------------ provenance

export const UNREAD_FIRST =
  'This discussion has unread posts, and reading it here would mark them read. Open it with get_discussion first, then prepare again.';

const HSU_UNSUPPORTED = 'Advanced Forums (hsuforum) are not supported for this action; use the Moodle site.';

export interface ForumTarget {
  forumType: ForumType;
  forumId: number;
  cmid: number;
  courseId: number;
  settings: ForumSettings | null;
}

/** The forum activity `cmid` must be of `forumType`; ids from the other module would name unrelated posts. */
export async function resolveForum(api: MoodleApi, cmid: number, forumType: ForumType): Promise<ForumTarget> {
  const cm = await getCourseModule(api, cmid);
  if (cm.modname !== 'forum' && cm.modname !== 'hsuforum') throw new InvalidInput(`Activity ${cmid} is not a forum.`);
  if (cm.modname !== forumType) {
    throw new InvalidInput(
      forumType === 'forum' ? HSU_UNSUPPORTED : `Activity ${cmid} is a standard forum; use forum_type "forum".`,
    );
  }
  const settings = await readForumSettings(api, forumType, cm.courseId, cm.instance);
  return { forumType, forumId: cm.instance, cmid, courseId: cm.courseId, settings };
}

export interface DiscussionEntry {
  id: number;
  firstPostId: number | null;
  numReplies: number;
  numUnread: number;
}

const DISCUSSIONS_PER_PAGE = 100;
const MAX_DISCUSSION_PAGES = 5;

/** The discussion as `mod_forum_get_forum_discussions` lists it in `forumId` (no read marking); null = not there. */
export async function findDiscussion(
  api: MoodleApi,
  forumId: number,
  discussionId: number,
): Promise<DiscussionEntry | null> {
  for (let page = 0; page < MAX_DISCUSSION_PAGES; page++) {
    const r = await tryCall<Raw>(api, 'mod_forum_get_forum_discussions', {
      forumid: forumId,
      sortorder: -1,
      page,
      perpage: DISCUSSIONS_PER_PAGE,
    });
    const list = r && Array.isArray(r.discussions) ? r.discussions.filter(isRec) : [];
    const d = list.find((x) => num(x.discussion) === discussionId);
    if (d) {
      return {
        id: discussionId,
        firstPostId: num(d.id),
        numReplies: Number(d.numreplies) || 0,
        numUnread: num(d.numunread) ?? 0,
      };
    }
    if (list.length < DISCUSSIONS_PER_PAGE) return null;
  }
  return null;
}

/** The discussion of `discussionId` must be in the target forum (fail closed). */
export async function requireDiscussion(
  api: MoodleApi,
  forum: ForumTarget,
  discussionId: number | null,
): Promise<DiscussionEntry> {
  const entry = discussionId === null ? null : await findDiscussion(api, forum.forumId, discussionId);
  if (!entry) throw new NotFound(`That post or discussion is not in forum_cmid ${forum.cmid}.`);
  return entry;
}

// ------------------------------------------------------------------ permissions

/** `mod_forum_get_forum_access_information` (has_capability per mod/forum capability); null when unavailable. */
export async function readForumAccess(api: MoodleApi, forumId: number): Promise<Raw | null> {
  const r = await tryCall<Raw>(api, 'mod_forum_get_forum_access_information', { forumid: forumId });
  return isRec(r) ? r : null;
}

/** mod/forum:createattachment for replies and edits; null when Moodle could not answer. */
export async function readCanAttach(api: MoodleApi, forumId: number): Promise<boolean | null> {
  return bool((await readForumAccess(api, forumId))?.cancreateattachment);
}

// ------------------------------------------------------------------ attachments

interface AttachmentLimits {
  maxFiles: number;
  maxBytes: number;
}

export const HSU_NO_FILES =
  'Advanced Forums (hsuforum) do not support attachments here. Post without files or attach them on Moodle.';

const NO_SETTINGS = "Could not read this forum's attachment settings. Try again or attach the files on Moodle.";

/**
 * Attachment limits, refusing whatever Moodle would silently ignore (forum_can_create_attachment): Advanced Forums,
 * forums without attachments, and users without mod/forum:createattachment. `canAttach` null = unknown = refused.
 */
export function attachmentLimits(
  s: ForumSettings | null,
  forumType: ForumType,
  canAttach: boolean | null,
): AttachmentLimits {
  if (forumType === 'hsuforum') throw new InvalidInput(HSU_NO_FILES);
  if (!s || s.maxAttachments === null) throw new InvalidInput(NO_SETTINGS);
  if (s.maxAttachments <= 0 || s.maxBytes === 1) throw new InvalidInput('This forum does not accept attachments.');
  if (canAttach === false) throw new InvalidInput('You cannot add attachments in this forum.');
  if (canAttach !== true) {
    throw new InvalidInput('Could not check whether you may add attachments here. Try again or use the Moodle site.');
  }
  return { maxFiles: s.maxAttachments, maxBytes: perFileLimit(s.maxBytes) };
}

interface StageOptions {
  forumType: ForumType;
  canAttach: boolean | null;
  files?: InlineFile[];
  uploadId?: string;
  /** Current attachments to keep (edit). */
  current?: FileRef[];
}

interface StagedAttachments {
  itemId: number;
  added: FileInfo[];
  /** Current attachments carried over (same-named new files replace them). */
  kept: FileRef[];
}

/**
 * New attachments of a forum post, checked against the forum's limits and permission and uploaded with the kept
 * current ones into one draft area at prepare time, so confirm is a single Moodle call.
 */
export async function stageForumFiles(
  ctx: ServiceContext,
  api: MoodleApi,
  s: ForumSettings | null,
  opts: StageOptions,
): Promise<StagedAttachments> {
  const limits = attachmentLimits(s, opts.forumType, opts.canAttach);
  if (!s?.cmid) throw new InvalidInput(NO_SETTINGS);
  const { files, uploadId } = opts;
  const staged = await gatherFiles(ctx, { cmid: s.cmid, what: 'forum', files, uploadId, maxBytes: limits.maxBytes });
  if (staged.all.length === 0) throw new InvalidInput('No files were uploaded to that upload link yet.');
  const names = checkFileList(staged.all, limits.maxBytes);
  const kept = (opts.current ?? []).filter((f) => !names.has(f.name.toLowerCase()));
  const count = staged.all.length + kept.length;
  if (count > limits.maxFiles) {
    const hint = kept.length > 0 ? ' Set keep_existing_files=false to replace the current ones.' : '';
    throw new InvalidInput(`Too many attachments: ${count} (this forum allows ${limits.maxFiles}).${hint}`);
  }
  await claimUpload(ctx, staged);
  let itemId = await uploadInline(api, staged.inline, staged.uploadRow?.draftItemId ?? null);
  for (const f of kept) itemId = await copyIntoDraft(api, f, itemId);
  if (itemId === null) throw new InvalidInput('No files were uploaded to that upload link yet.');
  return { itemId, added: staged.all, kept };
}

// ------------------------------------------------------------------ posts (mod_forum)

export interface ForumPost {
  id: number;
  discussionId: number | null;
  parentId: number | null;
  subject: string | null;
  /** HTML as Moodle exports it. */
  message: string;
  author: string | null;
  authorId: number | null;
  modified: number | null;
  canReply: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** forum_usermarksread is on and the forum is tracked: nothing is marked read automatically. */
  manualRead: boolean;
  attachments: FileRef[];
}

function mapPost(post: Raw): ForumPost | null {
  const id = num(post.id);
  if (id === null) return null;
  const caps = isRec(post.capabilities) ? post.capabilities : {};
  const author = isRec(post.author) ? post.author : {};
  return {
    id,
    discussionId: num(post.discussionid),
    parentId: post.hasparent === false ? null : num(post.parentid),
    subject: decoded(post.subject),
    message: str(post.message) ?? '',
    author: decoded(author.fullname),
    authorId: num(author.id),
    modified: num(post.timemodified),
    canReply: caps.reply === true,
    canEdit: caps.edit === true,
    canDelete: caps.delete === true,
    manualRead: caps.controlreadstatus === true,
    attachments: mapFiles(Array.isArray(post.attachments) ? (post.attachments as RawFile[]) : []),
  };
}

/** `mod_forum_get_discussion_post` (one post, no read marking); null when Moodle cannot show it. */
export async function lookupForumPost(api: MoodleApi, postId: number): Promise<ForumPost | null> {
  const r = await tryCall<Raw>(api, 'mod_forum_get_discussion_post', { postid: postId });
  return r && isRec(r.post) ? mapPost(r.post) : null;
}

/** The post, refusing what is missing or not the user's own (moderators' edit/delete-any rights are not used). */
export async function requireOwnPost(api: MoodleApi, postId: number): Promise<ForumPost> {
  const post = await lookupForumPost(api, postId);
  if (!post) throw new NotFound(`Post ${postId} was not found or is not visible.`);
  if (post.authorId === null || post.authorId !== api.moodleUserId) {
    throw new InvalidInput('Only your own posts can be edited or deleted here.');
  }
  return post;
}

interface ForumThread {
  posts: ForumPost[];
  /** Ids of the posts Moodle reported as unread before this call. */
  unread: number[];
}

/**
 * `mod_forum_get_discussion_posts`. It MARKS the returned posts read on tracked forums with automatic marking:
 * call it from executors, or through quietThread.
 */
export async function loadForumThread(api: MoodleApi, discussionId: number): Promise<ForumThread | null> {
  const r = await tryCall<Raw>(api, 'mod_forum_get_discussion_posts', {
    discussionid: discussionId,
    sortby: 'created',
    sortdirection: 'ASC',
  });
  if (!r || !Array.isArray(r.posts)) return null;
  const raw = r.posts.filter(isRec);
  const posts = raw.map(mapPost).filter((p): p is ForumPost => p !== null);
  const unread = raw.flatMap((p) => (p.unread === true && num(p.id) !== null ? [num(p.id) as number] : []));
  return { posts, unread };
}

/**
 * The whole thread, but only when reading it changes no read state (untracked forum, manual marking, or nothing
 * unread in the discussion); null otherwise. Throws when Moodle cannot return it.
 */
export async function quietThread(
  api: MoodleApi,
  tracked: boolean | null,
  entry: DiscussionEntry,
  manualRead: boolean,
): Promise<ForumThread | null> {
  if (!(tracked === false || manualRead || entry.numUnread === 0)) return null;
  const thread = await loadForumThread(api, entry.id);
  if (!thread) throw new InvalidInput('Could not read the discussion. Try again.');
  return thread;
}

/** Ids of the post's replies, their replies, … (Moodle deletes them along with it), ascending. */
export function descendantIds(posts: ForumPost[], postId: number): number[] {
  const children = new Map<number, number[]>();
  for (const p of posts) {
    if (p.parentId !== null) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p.id]);
  }
  const out: number[] = [];
  const queue = [...(children.get(postId) ?? [])];
  while (queue.length > 0) {
    const next = queue.pop() as number;
    out.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out.sort((a, b) => a - b);
}
