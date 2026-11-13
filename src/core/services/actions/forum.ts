/** Forum posts: replies and new discussions (with attachments) on mod_forum and Open LMS mod_hsuforum. */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput, NotFound } from '../../errors';
import { formatBytes } from '../../format';
import { nowMs } from '../../time';
import type { ActionKind, ActionPreview, InlineFile } from '../../types';
import type { ForumType } from '../forums';
import {
  decoded,
  type ForumSettings,
  HSU_NO_FILES,
  lookupForumPost,
  postingWindow,
  readCanAttach,
  readForumSettings,
  requireDiscussion,
  resolveForum,
  stageForumFiles,
} from './forum-info';
import type { FileInfo } from './inline-files';
import {
  type ActionOutcome,
  assertWriteAllowed,
  isRec,
  isSet,
  num,
  positiveInt,
  type Raw,
  refusal,
  requireText,
  savePreview,
  truncate,
  tryCall,
} from './shared';
import { markdownToSimpleHtml } from './text';

const MAX_POST_CHARS = 20_000;
/** Moodle FORMAT_HTML: every body this service sends is HTML (markdownToSimpleHtml). */
const FORMAT_HTML = 1;
const NO_REPLY = "You can't reply to that post (for example, in announcement forums only teachers post).";
const UNCHECKED_DATES = "The forum's due and cut-off dates were not checked; Moodle still enforces them.";

export interface PrepareForumPostInput {
  forumType: ForumType;
  replyToPostId?: number;
  forumId?: number;
  /** hsuforum replies: the discussion of the parent post (Moodle has no lookup by post id there). */
  discussionId?: number;
  /** Replies: the forum activity, for its dates and attachment limits (verified to contain the post). */
  forumCmid?: number;
  subject?: string;
  message: string;
  files?: InlineFile[];
  uploadId?: string;
  /** Subscribe to the discussion; undefined = Moodle's default. */
  discussionSubscribe?: boolean;
}

type ForumPayload = {
  forumType: ForumType;
  postId: number | null;
  forumId: number | null;
  discussionId: number | null;
  subject: string;
  message: string;
  /** Draft area holding the attachments; null = none. */
  attachmentsId?: number | null;
  discussionSubscribe?: boolean | null;
};

interface ForumRequest {
  type: ForumType;
  replyTo: number | null;
  forumId: number | null;
  discussionId: number | null;
  forumCmid: number | null;
  subject: string;
  message: string;
  files?: InlineFile[];
  uploadId?: string;
  hasFiles: boolean;
  discussionSubscribe: boolean | null;
}

/** What the preview needs to know about the reply target or the forum. */
interface Target {
  kind: ActionKind;
  title: string;
  line: string;
  subject: string;
  discussionId: number | null;
  settings: ForumSettings | null;
  /** mod/forum:createattachment; null = unknown (attachments are then refused). */
  canAttach: boolean | null;
  warnings: string[];
}

function parseRequest(input: PrepareForumPostInput): ForumRequest {
  const type = input.forumType;
  if (type !== 'forum' && type !== 'hsuforum') throw new InvalidInput("forum_type must be 'forum' or 'hsuforum'.");
  if (isSet(input.replyToPostId) === isSet(input.forumId)) {
    throw new InvalidInput('Provide either reply_to_post_id (reply) or forum_id (new discussion), not both.');
  }
  const message = requireText(input.message, 'post text', MAX_POST_CHARS);
  const discussionSubscribe = typeof input.discussionSubscribe === 'boolean' ? input.discussionSubscribe : null;
  if (type === 'hsuforum' && discussionSubscribe !== null) {
    throw new InvalidInput('discussion_subscribe is not supported for Advanced Forums (hsuforum).');
  }
  const hasFiles = (input.files?.length ?? 0) > 0 || !!input.uploadId;
  if (type === 'hsuforum' && hasFiles) throw new InvalidInput(HSU_NO_FILES);
  return {
    type,
    replyTo: input.replyToPostId ?? null,
    forumId: input.forumId ?? null,
    discussionId: input.discussionId ?? null,
    forumCmid: input.forumCmid ?? null,
    subject: input.subject?.trim() ?? '',
    message,
    files: input.files,
    uploadId: input.uploadId,
    hasFiles,
    discussionSubscribe,
  };
}

interface ParentPost {
  subject: string | null;
  discussionId: number;
  author: string | null;
}

/** mod_forum: one post by id (no read marking); the reply capability is checked before anything else is read. */
async function lookupForumParent(api: MoodleApi, postId: number): Promise<ParentPost> {
  const post = await lookupForumPost(api, postId);
  if (!post || post.discussionId === null) {
    throw new NotFound(`Post ${postId} was not found or is not visible; open the discussion with get_discussion.`);
  }
  if (!post.canReply) throw new InvalidInput(NO_REPLY);
  return { subject: post.subject, discussionId: post.discussionId, author: post.author };
}

/**
 * mod_hsuforum only lists a discussion's posts, so the caller must name the discussion; a discussion that lacks the
 * post is refused (the reply would land in the wrong place or fail).
 */
async function lookupHsuforumParent(api: MoodleApi, postId: number, discussionId: number | null): Promise<ParentPost> {
  if (discussionId === null) throw new InvalidInput('discussion_id is required to reply in an Advanced Forum.');
  const r = await tryCall<Raw>(api, 'mod_hsuforum_get_forum_discussion_posts', { discussionid: discussionId });
  if (!r || !Array.isArray(r.posts)) throw new InvalidInput(`Could not read discussion ${discussionId}. Try again.`);
  const post = r.posts.find((p): p is Raw => isRec(p) && num(p.id) === postId);
  if (!post) {
    throw new InvalidInput(`post ${postId} is not in discussion ${discussionId}; open it with get_discussion`);
  }
  if (post.canreply !== true) throw new InvalidInput(NO_REPLY);
  const author = isRec(post.author) ? post.author.fullname : post.userfullname;
  return { subject: decoded(post.subject), discussionId, author: decoded(author) };
}

const replySubject = (parentSubject: string | null) => {
  if (!parentSubject) return 'Re: discussion';
  return /^re:/i.test(parentSubject) ? parentSubject : `Re: ${parentSubject}`;
};

/** Dates and attachment permission of the reply's forum, from forum_cmid (which must contain the discussion). */
async function replyForum(api: MoodleApi, req: ForumRequest, discussionId: number) {
  if (req.forumCmid === null) {
    if (req.hasFiles) throw new InvalidInput('Pass forum_cmid (from list_discussions) to attach files to a reply.');
    return { settings: null, canAttach: null, warnings: [`${UNCHECKED_DATES} Pass forum_cmid to see them.`] };
  }
  const forum = await resolveForum(api, positiveInt(req.forumCmid, 'forum_cmid'), req.type);
  if (req.type === 'forum') await requireDiscussion(api, forum, discussionId);
  const canAttach = req.hasFiles && req.type === 'forum' ? await readCanAttach(api, forum.forumId) : null;
  return { settings: forum.settings, canAttach, warnings: [] };
}

async function replyTarget(api: MoodleApi, req: ForumRequest, postId: number): Promise<Target> {
  const parent =
    req.type === 'forum'
      ? await lookupForumParent(api, postId)
      : await lookupHsuforumParent(api, postId, req.discussionId);
  const forum = await replyForum(api, req, parent.discussionId);
  const by = parent.author ? ` by ${parent.author}` : '';
  return {
    kind: 'forum_reply',
    title: parent.subject ? `Reply to "${truncate(parent.subject, 60)}"` : `Reply to post ${postId}`,
    line: `Replying to: "${parent.subject ?? `post ${postId}`}"${by}`,
    subject: req.subject || replySubject(parent.subject),
    discussionId: parent.discussionId,
    ...forum,
  };
}

/** `mod_*_can_add_discussion`, required: a missing or malformed answer refuses the preparation. */
async function canAddDiscussion(api: MoodleApi, req: ForumRequest, forumId: number) {
  const r = await tryCall<Raw>(api, `mod_${req.type}_can_add_discussion`, { forumid: forumId });
  if (!isRec(r) || typeof r.status !== 'boolean') {
    throw new InvalidInput('Could not check whether you may start a discussion in this forum. Try again.');
  }
  if (!r.status) {
    throw new InvalidInput(
      "You can't start a discussion in this forum (for example, in announcement forums only teachers post).",
    );
  }
  return typeof r.cancreateattachment === 'boolean' ? r.cancreateattachment : null;
}

async function discussionTarget(api: MoodleApi, req: ForumRequest, forumId: number): Promise<Target> {
  if (!req.subject) throw new InvalidInput('A new discussion needs a subject.');
  const canAttach = await canAddDiscussion(api, req, forumId);
  const r = await tryCall<Raw>(api, 'core_course_get_course_module_by_instance', {
    module: req.type,
    instance: forumId,
  });
  const cm = r && isRec(r.cm) ? r.cm : null;
  const courseId = num(cm?.course);
  const settings = courseId === null ? null : await readForumSettings(api, req.type, courseId, forumId);
  const forumName = settings?.name ?? decoded(cm?.name) ?? `forum ${forumId}`;
  return {
    kind: 'forum_discussion',
    title: `New discussion in ${forumName}`,
    line: `Forum: ${forumName}`,
    subject: req.subject,
    discussionId: null,
    settings,
    canAttach,
    warnings: settings ? [] : [UNCHECKED_DATES],
  };
}

/** Attachments go into a draft area now; null = none. */
async function stageAttachments(
  ctx: ServiceContext,
  api: MoodleApi,
  req: ForumRequest,
  target: Target,
): Promise<{ itemId: number | null; files: FileInfo[] }> {
  if (!req.hasFiles) return { itemId: null, files: [] };
  const { files, uploadId } = req;
  const opts = { forumType: req.type, canAttach: target.canAttach, files, uploadId };
  const staged = await stageForumFiles(ctx, api, target.settings, opts);
  return { itemId: staged.itemId, files: staged.added };
}

const fileLines = (files: FileInfo[]) =>
  files.map((f) => `Attachment: ${f.name} (${formatBytes(f.size)})${f.source ? ` — from ${f.source}` : ''}`);

const subscribeLine = (v: boolean | null) => (v === null ? [] : [`Subscribe to this discussion: ${v ? 'yes' : 'no'}`]);

export async function prepareForumPost(ctx: ServiceContext, input: PrepareForumPostInput): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  const req = parseRequest(input);
  const api = await ctx.moodle();
  const target =
    req.replyTo !== null
      ? await replyTarget(api, req, positiveInt(req.replyTo, 'reply_to_post_id'))
      : await discussionTarget(api, req, positiveInt(req.forumId, 'forum_id'));
  if (target.subject.length > 255) throw new InvalidInput('The subject is too long (max 255 characters).');
  const dates = postingWindow(target.settings, nowMs());
  const attachments = await stageAttachments(ctx, api, req, target);
  const payload: ForumPayload = {
    forumType: req.type,
    postId: req.replyTo,
    forumId: req.forumId,
    discussionId: target.discussionId,
    subject: target.subject,
    message: req.message,
    attachmentsId: attachments.itemId,
    discussionSubscribe: req.discussionSubscribe,
  };
  return savePreview(ctx, {
    kind: target.kind,
    title: target.title,
    details: [
      target.line,
      ...dates.details,
      `Subject: ${target.subject}`,
      `Message: ${req.message}`,
      ...fileLines(attachments.files),
      ...subscribeLine(req.discussionSubscribe),
    ],
    warnings: ['This post will be visible to other course members.', ...dates.warnings, ...target.warnings],
    payload,
  });
}

// ------------------------------------------------------------------ execute

const discussUrl = (api: MoodleApi, p: ForumPayload, discussionId: number | null, postId?: number) => {
  if (!discussionId) return null;
  return `${api.baseUrl}/mod/${p.forumType}/discuss.php?d=${discussionId}${postId ? `#p${postId}` : ''}`;
};

/** add_discussion / add_discussion_post `options`; omitted entirely when empty (hsuforum takes none). */
function postOptions(p: ForumPayload): Raw {
  const options: Raw[] = [];
  if (typeof p.discussionSubscribe === 'boolean') {
    options.push({ name: 'discussionsubscribe', value: p.discussionSubscribe });
  }
  if (typeof p.attachmentsId === 'number') options.push({ name: 'attachmentsid', value: p.attachmentsId });
  return options.length > 0 ? { options } : {};
}

export async function executeForumReply(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as ForumPayload;
  const params: Raw = { postid: p.postId, subject: p.subject, message: markdownToSimpleHtml(p.message) };
  // mod_hsuforum's twin predates messageformat; Moodle assumes HTML when it is absent.
  if (p.forumType === 'forum') params.messageformat = FORMAT_HTML;
  const fn = p.forumType === 'forum' ? 'mod_forum_add_discussion_post' : 'mod_hsuforum_add_discussion_post';
  const res = await api.call<unknown>(fn, { ...params, ...postOptions(p) });
  const postId = isRec(res) ? num(res.postid) : null;
  if (!postId) throw refusal('refused the reply', res);
  return { message: 'Reply posted.', url: discussUrl(api, p, p.discussionId, postId) };
}

export async function executeForumDiscussion(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as ForumPayload;
  const fn = p.forumType === 'forum' ? 'mod_forum_add_discussion' : 'mod_hsuforum_add_discussion';
  // add_discussion has no messageformat: Moodle always stores the message as HTML.
  const res = await api.call<unknown>(fn, {
    forumid: p.forumId,
    subject: p.subject,
    message: markdownToSimpleHtml(p.message),
    ...postOptions(p),
  });
  const discussionId = isRec(res) ? (num(res.discussionid) ?? num(res.discussion)) : null;
  if (!discussionId) throw refusal('refused the new discussion', res);
  return { message: 'Discussion created.', url: discussUrl(api, p, discussionId) };
}
