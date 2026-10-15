/** Forum posts: replies and new discussions on mod_forum and Open LMS mod_hsuforum. */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput } from '../../errors';
import { decodeEntities } from '../../html';
import type { ActionKind, ActionPreview } from '../../types';
import {
  type ActionOutcome,
  assertWriteAllowed,
  isRec,
  isSet,
  num,
  positiveInt,
  previewText,
  type Raw,
  refusal,
  requireText,
  savePreview,
  str,
  truncate,
  tryCall,
} from './shared';
import { markdownToSimpleHtml } from './text';

const MAX_POST_CHARS = 20_000;

type ForumType = 'forum' | 'hsuforum';

export interface PrepareForumPostInput {
  forumType: ForumType;
  replyToPostId?: number;
  forumId?: number;
  /** hsuforum only: lets the preview look the parent post up (Moodle has no lookup by post id there). */
  discussionId?: number;
  subject?: string;
  message: string;
}

type ForumPayload = {
  forumType: ForumType;
  postId: number | null;
  forumId: number | null;
  discussionId: number | null;
  subject: string;
  message: string;
};

interface ForumRequest {
  type: ForumType;
  replyTo: number | null;
  forumId: number | null;
  discussionId: number | null;
  subject: string;
  message: string;
}

/** What the preview needs to know about the reply target or the forum. */
interface Target {
  kind: ActionKind;
  title: string;
  line: string;
  subject: string;
  discussionId: number | null;
}

function parseRequest(input: PrepareForumPostInput): ForumRequest {
  const type = input.forumType;
  if (type !== 'forum' && type !== 'hsuforum') throw new InvalidInput("forum_type must be 'forum' or 'hsuforum'.");
  if (isSet(input.replyToPostId) === isSet(input.forumId)) {
    throw new InvalidInput('Provide either reply_to_post_id (reply) or forum_id (new discussion), not both.');
  }
  const message = requireText(input.message, 'post text', MAX_POST_CHARS);
  return {
    type,
    replyTo: input.replyToPostId ?? null,
    forumId: input.forumId ?? null,
    discussionId: input.discussionId ?? null,
    subject: input.subject?.trim() ?? '',
    message,
  };
}

interface ParentPost {
  subject: string | null;
  discussionId: number | null;
  author: string | null;
  canReply: boolean;
}

const decoded = (v: unknown): string | null => {
  const text = str(v);
  return text ? decodeEntities(text) : null;
};

/** mod_forum can look a post up by id. */
async function lookupForumPost(api: MoodleApi, postId: number): Promise<ParentPost | null> {
  const r = await tryCall<Raw>(api, 'mod_forum_get_discussion_post', { postid: postId });
  const post = r && isRec(r.post) ? r.post : null;
  if (!post) return null;
  const caps = isRec(post.capabilities) ? post.capabilities : null;
  return {
    subject: decoded(post.subject),
    discussionId: num(post.discussionid),
    author: isRec(post.author) ? decoded(post.author.fullname) : null,
    canReply: caps?.reply !== false,
  };
}

/**
 * mod_hsuforum only lists a discussion's posts, so the caller must know the discussion; a listed discussion
 * that lacks the post is refused (the reply would land in the wrong place or fail).
 */
async function lookupHsuforumPost(api: MoodleApi, postId: number, discussionId: number): Promise<ParentPost | null> {
  const r = await tryCall<Raw>(api, 'mod_hsuforum_get_forum_discussion_posts', { discussionid: discussionId });
  if (!r || !Array.isArray(r.posts)) return null;
  const post = r.posts.find((p): p is Raw => isRec(p) && num(p.id) === postId);
  if (!post) {
    throw new InvalidInput(`post ${postId} is not in discussion ${discussionId}; open it with get_discussion`);
  }
  const author = isRec(post.author) ? post.author.fullname : post.userfullname;
  return { subject: decoded(post.subject), discussionId, author: decoded(author), canReply: true };
}

async function lookupParent(api: MoodleApi, req: ForumRequest, postId: number): Promise<ParentPost | null> {
  if (req.type === 'forum') return lookupForumPost(api, postId);
  return req.discussionId === null ? null : lookupHsuforumPost(api, postId, req.discussionId);
}

const replySubject = (parentSubject: string | null) => {
  if (!parentSubject) return 'Re: discussion';
  return /^re:/i.test(parentSubject) ? parentSubject : `Re: ${parentSubject}`;
};

async function replyTarget(api: MoodleApi, req: ForumRequest, postId: number): Promise<Target> {
  const parent = await lookupParent(api, req, postId);
  if (parent && !parent.canReply) throw new InvalidInput("You can't reply to that post.");
  const parentSubject = parent?.subject ?? null;
  const by = parent?.author ? ` by ${parent.author}` : '';
  return {
    kind: 'forum_reply',
    title: parentSubject ? `Reply to "${truncate(parentSubject, 60)}"` : `Reply to post ${postId}`,
    line: parent ? `Replying to: "${parentSubject ?? `post ${postId}`}"${by}` : `Replying to post ${postId}`,
    subject: req.subject || replySubject(parentSubject),
    discussionId: parent?.discussionId ?? req.discussionId,
  };
}

async function discussionTarget(api: MoodleApi, req: ForumRequest, forumId: number): Promise<Target> {
  if (!req.subject) throw new InvalidInput('A new discussion needs a subject.');
  const r = await tryCall<Raw>(api, 'core_course_get_course_module_by_instance', {
    module: req.type,
    instance: forumId,
  });
  const name = r && isRec(r.cm) ? str(r.cm.name) : null;
  const forumName = name ? decodeEntities(name) : `forum ${forumId}`;
  return {
    kind: 'forum_discussion',
    title: `New discussion in ${forumName}`,
    line: `Forum: ${forumName}`,
    subject: req.subject,
    discussionId: null,
  };
}

export async function prepareForumPost(ctx: ServiceContext, input: PrepareForumPostInput): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  const req = parseRequest(input);
  const api = await ctx.moodle();
  const target =
    req.replyTo !== null
      ? await replyTarget(api, req, positiveInt(req.replyTo, 'reply_to_post_id'))
      : await discussionTarget(api, req, positiveInt(req.forumId, 'forum_id'));
  if (target.subject.length > 255) throw new InvalidInput('The subject is too long (max 255 characters).');
  const payload: ForumPayload = {
    forumType: req.type,
    postId: req.replyTo,
    forumId: req.forumId,
    discussionId: target.discussionId,
    subject: target.subject,
    message: req.message,
  };
  return savePreview(ctx, {
    kind: target.kind,
    title: target.title,
    details: [target.line, `Subject: ${target.subject}`, `Message: ${previewText(req.message)}`],
    warnings: ['This post will be visible to other course members.'],
    payload,
  });
}

// ------------------------------------------------------------------ execute

const discussUrl = (api: MoodleApi, p: ForumPayload, discussionId: number | null, postId?: number) => {
  if (!discussionId) return null;
  return `${api.baseUrl}/mod/${p.forumType}/discuss.php?d=${discussionId}${postId ? `#p${postId}` : ''}`;
};

export async function executeForumReply(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as ForumPayload;
  const params: Raw = { postid: p.postId, subject: p.subject, message: markdownToSimpleHtml(p.message) };
  if (p.forumType === 'forum') params.messageformat = 1;
  const fn = p.forumType === 'forum' ? 'mod_forum_add_discussion_post' : 'mod_hsuforum_add_discussion_post';
  const res = await api.call<unknown>(fn, params);
  const postId = isRec(res) ? num(res.postid) : null;
  if (!postId) throw refusal('refused the reply', res);
  return { message: 'Reply posted.', url: discussUrl(api, p, p.discussionId, postId) };
}

export async function executeForumDiscussion(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as ForumPayload;
  const fn = p.forumType === 'forum' ? 'mod_forum_add_discussion' : 'mod_hsuforum_add_discussion';
  const res = await api.call<unknown>(fn, {
    forumid: p.forumId,
    subject: p.subject,
    message: markdownToSimpleHtml(p.message),
  });
  const discussionId = isRec(res) ? (num(res.discussionid) ?? num(res.discussion)) : null;
  if (!discussionId) throw refusal('refused the new discussion', res);
  return { message: 'Discussion created.', url: discussUrl(api, p, discussionId) };
}
