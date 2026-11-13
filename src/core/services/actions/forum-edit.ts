/**
 * Editing and deleting one's own posts in standard forums (mod_forum; Open LMS mod_hsuforum has no WS for it).
 * Targets carry their forum (forum_cmid), so an id from the other forum module can never name an unrelated post.
 */

import type { MoodleApi, ServiceContext } from '../../context';
import { sha256Hex } from '../../crypto';
import { InvalidInput } from '../../errors';
import { formatBytes } from '../../format';
import { htmlToMarkdown } from '../../html';
import type { ActionPreview, FileRef, InlineFile } from '../../types';
import { allocateDraft } from './drafts';
import {
  attachmentLimits,
  type DiscussionEntry,
  descendantIds,
  type ForumPost,
  type ForumTarget,
  findDiscussion,
  lookupForumPost,
  quietThread,
  readCanAttach,
  readForumAccess,
  requireDiscussion,
  requireOwnPost,
  resolveForum,
  stageForumFiles,
  UNREAD_FIRST,
} from './forum-info';
import type { FileInfo } from './inline-files';
import {
  type ActionOutcome,
  assertWriteAllowed,
  isRec,
  positiveInt,
  type Raw,
  refusal,
  requireText,
  savePreview,
  truncate,
} from './shared';
import { markdownToSimpleHtml } from './text';

/** The whole text goes into the stored preview (console and structured result show it in full). */
const MAX_POST_CHARS = 20_000;
const FORMAT_HTML = 1;
/** mod_forum `forcesubscribe` values where the user has no per-discussion choice. */
const FORCED = 1;
const DISABLED = 3;

interface PrepareForumPostChangeInput {
  forumCmid: number;
  postId: number;
  action: 'edit' | 'delete';
  subject?: string;
  message?: string;
  files?: InlineFile[];
  uploadId?: string;
  /** Edit: keep the current attachments (same-named new files replace them). Default true. */
  keepExistingFiles?: boolean;
  /** Edit: discussion subscription after saving (Moodle sets it on every edit). Default true. */
  discussionSubscribe?: boolean;
}

type EditPayload = {
  postId: number;
  discussionId: number | null;
  /** '' = unchanged (Moodle keeps the current value). */
  subject: string;
  /** Markdown; null = unchanged. */
  message: string | null;
  /** Draft area with exactly the attachments to keep; null = attachments untouched. */
  attachmentsId: number | null;
  /** Sent explicitly: update_discussion_post unsubscribes when the option is missing. null = forum decides. */
  discussionSubscribe: boolean | null;
};

type DeletePayload = {
  postId: number;
  discussionId: number;
  forumId: number;
  isDiscussion: boolean;
  tracked: boolean | null;
  /** sha256 of subject, text, modification time and attachments as previewed. */
  fingerprint: string;
  /** Posts deleted along with it, as previewed (ascending). */
  descendants: number[];
};

const postLabel = (p: ForumPost) => `"${truncate(p.subject ?? `post ${p.id}`, 60)}"`;
const byLine = (p: ForumPost) => `Post: ${postLabel(p)}${p.author ? ` by ${p.author}` : ''}`;
const currentText = (p: ForumPost) => htmlToMarkdown(p.message);
const discussUrl = (api: MoodleApi, discussionId: number | null, postId?: number) =>
  discussionId ? `${api.baseUrl}/mod/forum/discuss.php?d=${discussionId}${postId ? `#p${postId}` : ''}` : null;

// ------------------------------------------------------------------ edit

interface FileChange {
  itemId: number | null;
  added: FileInfo[];
  kept: FileRef[];
  removed: FileRef[];
}

const NO_FILE_CHANGE: FileChange = { itemId: null, added: [], kept: [], removed: [] };

/** The resolved own post being edited or deleted, with its forum. */
interface OwnPost {
  ctx: ServiceContext;
  api: MoodleApi;
  forum: ForumTarget;
  post: ForumPost;
}

/** New attachments plus the kept current ones in one draft; an empty draft clears them all. */
async function stageFiles({ ctx, api, forum, post }: OwnPost, input: PrepareForumPostChangeInput): Promise<FileChange> {
  const keep = input.keepExistingFiles ?? true;
  const adds = (input.files?.length ?? 0) > 0 || !!input.uploadId;
  if (!adds && (keep || post.attachments.length === 0)) return NO_FILE_CHANGE;
  // Moodle ignores attachment changes without the permission, so even clearing needs it.
  const canAttach = await readCanAttach(api, forum.forumId);
  if (!adds) {
    attachmentLimits(forum.settings, 'forum', canAttach);
    return { itemId: await allocateDraft(api), added: [], kept: [], removed: post.attachments };
  }
  const current = keep ? post.attachments : [];
  const { files, uploadId } = input;
  const opts = { forumType: 'forum' as const, canAttach, files, uploadId, current };
  const staged = await stageForumFiles(ctx, api, forum.settings, opts);
  return { ...staged, removed: post.attachments.filter((f) => !staged.kept.includes(f)) };
}

/** forum_post_subscription runs on every edit: send the intended state, and only where the user has a choice. */
function subscriptionChoice(forum: ForumTarget, wanted: boolean | undefined): boolean | null {
  const mode = forum.settings?.forceSubscribe;
  if (mode === undefined || mode === null) throw new InvalidInput("Could not read this forum's settings. Try again.");
  if (mode === FORCED || mode === DISABLED) {
    if (wanted !== undefined) throw new InvalidInput('This forum fixes subscriptions; omit discussion_subscribe.');
    return null;
  }
  return wanted ?? true;
}

function editDetails(post: ForumPost, edit: EditPayload, files: FileChange): string[] {
  const details = [byLine(post)];
  if (edit.subject) details.push(`Current subject: ${post.subject ?? '-'}`, `New subject: ${edit.subject}`);
  if (edit.message !== null) details.push(`Current text: ${currentText(post)}`, `New text: ${edit.message}`);
  for (const f of files.added) details.push(`New attachment: ${f.name} (${formatBytes(f.size)})`);
  for (const f of files.kept) details.push(`Kept attachment: ${f.name} (${formatBytes(f.size)})`);
  for (const f of files.removed) details.push(`Removed attachment: ${f.name}`);
  if (edit.discussionSubscribe !== null) {
    const state = edit.discussionSubscribe ? 'on' : 'off';
    details.push(`Discussion subscription after saving: ${state} (Moodle sets it on every edit)`);
  }
  return details;
}

async function prepareEdit(own: OwnPost, input: PrepareForumPostChangeInput) {
  const { ctx, forum, post } = own;
  if (!post.canEdit) {
    throw new InvalidInput("You can't edit this post: Moodle allows edits only within its editing time.");
  }
  const subject = input.subject?.trim() ?? '';
  if (subject.length > 255) throw new InvalidInput('The subject is too long (max 255 characters).');
  const message = input.message === undefined ? null : requireText(input.message, 'post text', MAX_POST_CHARS);
  const touchesFiles = (input.files?.length ?? 0) > 0 || !!input.uploadId || input.keepExistingFiles === false;
  if (!subject && message === null && !touchesFiles) {
    throw new InvalidInput('Nothing to change: provide subject, message, files or keep_existing_files=false.');
  }
  const discussionSubscribe = subscriptionChoice(forum, input.discussionSubscribe);
  const files = await stageFiles(own, input);
  const payload: EditPayload = {
    postId: post.id,
    discussionId: post.discussionId,
    subject,
    message,
    attachmentsId: files.itemId,
    discussionSubscribe,
  };
  const warnings = ['The edited post is visible to other course members.'];
  if (files.removed.length > 0 && files.added.length === 0 && files.kept.length === 0) {
    warnings.push('Removes all attachments from the post.');
  }
  return savePreview(ctx, {
    kind: 'forum_post_edit',
    title: `Edit post ${postLabel(post)}`,
    details: editDetails(post, payload, files),
    warnings,
    payload,
  });
}

export async function executeForumPostEdit(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as EditPayload;
  const options: Raw[] = [];
  if (typeof p.discussionSubscribe === 'boolean') {
    options.push({ name: 'discussionsubscribe', value: p.discussionSubscribe });
  }
  if (p.attachmentsId !== null) options.push({ name: 'attachmentsid', value: p.attachmentsId });
  const res = await api.call<unknown>('mod_forum_update_discussion_post', {
    postid: p.postId,
    subject: p.subject,
    message: p.message === null ? '' : markdownToSimpleHtml(p.message),
    messageformat: FORMAT_HTML,
    ...(options.length > 0 ? { options } : {}),
  });
  if (!isRec(res) || res.status !== true) throw refusal('did not update the post', res);
  return { message: 'Post updated.', url: discussUrl(api, p.discussionId, p.postId) };
}

// ------------------------------------------------------------------ delete

const STALE = 'The post or its replies changed since the preview. Open the discussion and prepare the deletion again.';

const fingerprint = (p: ForumPost) =>
  sha256Hex(JSON.stringify([p.subject, p.message, p.modified, p.attachments.map((f) => [f.name, f.size])]));

/** Posts deleted along with `post`; null when they cannot be read without marking unread posts read. */
async function deletionScope(
  api: MoodleApi,
  post: ForumPost,
  entry: DiscussionEntry,
  tracked: boolean | null,
): Promise<number[] | null> {
  if (post.parentId === null && entry.numReplies === 0) return [];
  const thread = await quietThread(api, tracked, entry, post.manualRead);
  if (!thread) return null;
  if (post.parentId !== null) return descendantIds(thread.posts, post.id);
  return thread.posts
    .filter((x) => x.id !== post.id)
    .map((x) => x.id)
    .sort((a, b) => a - b);
}

function deleteWarnings(isDiscussion: boolean, replies: number): string[] {
  const warnings = ['This cannot be undone.'];
  if (isDiscussion) warnings.push('This is the first post: the whole discussion and all its replies are deleted.');
  else if (replies === 1) warnings.push('1 reply under this post is deleted too.');
  else if (replies > 1) warnings.push(`${replies} replies under this post are deleted too.`);
  return warnings;
}

async function prepareDelete({ ctx, api, forum, post }: OwnPost, entry: DiscussionEntry) {
  if (!post.canDelete) {
    throw new InvalidInput("You can't delete this post: Moodle allows it only within its editing time.");
  }
  const tracked = forum.settings?.tracked ?? null;
  const descendants = await deletionScope(api, post, entry, tracked);
  if (!descendants) {
    throw new InvalidInput(UNREAD_FIRST);
  }
  // capabilities.delete is computed as if the post had no replies; deleting replies needs mod/forum:deleteanypost.
  if (descendants.length > 0 && (await readForumAccess(api, forum.forumId))?.candeleteanypost !== true) {
    throw new InvalidInput(`Moodle does not let you delete a post that has replies (${descendants.length}).`);
  }
  const isDiscussion = post.parentId === null;
  const details = [byLine(post), `Text: ${currentText(post)}`];
  for (const f of post.attachments) details.push(`Attachment: ${f.name} (${formatBytes(f.size)})`);
  const payload: DeletePayload = {
    postId: post.id,
    discussionId: entry.id,
    forumId: forum.forumId,
    isDiscussion,
    tracked,
    fingerprint: await fingerprint(post),
    descendants,
  };
  return savePreview(ctx, {
    kind: 'forum_post_delete',
    title: `${isDiscussion ? 'Delete discussion' : 'Delete post'} ${postLabel(post)}`,
    details,
    warnings: deleteWarnings(isDiscussion, descendants.length),
    payload,
  });
}

/** Re-reads the post and its scope; anything different from the approved preview refuses the deletion. */
async function assertUnchanged(api: MoodleApi, p: DeletePayload): Promise<void> {
  const post = await lookupForumPost(api, p.postId);
  if (!post || (await fingerprint(post)) !== p.fingerprint) throw new InvalidInput(STALE);
  const entry = await findDiscussion(api, p.forumId, p.discussionId);
  const scope = entry ? await deletionScope(api, post, entry, p.tracked) : null;
  if (!scope || scope.join(',') !== p.descendants.join(',')) throw new InvalidInput(STALE);
}

export async function executeForumPostDelete(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as DeletePayload;
  await assertUnchanged(api, p);
  const res = await api.call<unknown>('mod_forum_delete_post', { postid: p.postId });
  if (!isRec(res) || res.status !== true) throw refusal('did not delete the post', res);
  return {
    message: p.isDiscussion ? 'Discussion deleted.' : 'Post deleted.',
    url: p.isDiscussion ? null : discussUrl(api, p.discussionId),
  };
}

// ------------------------------------------------------------------ entry

export async function prepareForumPostChange(
  ctx: ServiceContext,
  input: PrepareForumPostChangeInput,
): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  const postId = positiveInt(input.postId, 'post_id');
  if (input.action !== 'edit' && input.action !== 'delete') {
    throw new InvalidInput("action must be 'edit' or 'delete'.");
  }
  const api = await ctx.moodle();
  const forum = await resolveForum(api, positiveInt(input.forumCmid, 'forum_cmid'), 'forum');
  const post = await requireOwnPost(api, postId);
  const entry = await requireDiscussion(api, forum, post.discussionId);
  const own: OwnPost = { ctx, api, forum, post };
  if (input.action === 'delete') {
    const { subject, message, files, uploadId, keepExistingFiles, discussionSubscribe } = input;
    const extra = [subject, message, files, uploadId, keepExistingFiles, discussionSubscribe];
    if (extra.some((v) => v !== undefined)) throw new InvalidInput('Delete takes only forum_cmid and post_id.');
    return prepareDelete(own, entry);
  }
  return prepareEdit(own, input);
}
