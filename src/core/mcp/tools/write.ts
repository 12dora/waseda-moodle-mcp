import * as z from 'zod';
import {
  cancelAction,
  confirmAction,
  prepareCompletion,
  prepareForumPost,
  prepareForumPostChange,
  prepareForumSubscription,
  prepareMessage,
  prepareSubmission,
} from '../../services/actions';
import type { InlineFile } from '../../types';
import { renderActionPreview, renderActionResult } from '../render/actions';
import { actionPreviewOut, actionResultOut } from '../schemas/actions';
import { defineTool, id, PREPARE_HINTS } from './define';
import { prepareQuestionnaireTool } from './write-questionnaire';

interface FileArg {
  name: string;
  text?: string;
  content_base64?: string;
  path?: string;
}

interface FileArgs {
  files?: FileArg[];
  upload_id?: string;
}

interface SubmissionArgs extends FileArgs {
  cmid: number;
  online_text?: string;
  keep_existing_files?: boolean;
  submit_for_grading?: boolean;
  accept_statement?: boolean;
}

interface ForumPostArgs extends FileArgs {
  forum_type: 'forum' | 'hsuforum';
  reply_to_post_id?: number;
  forum_id?: number;
  discussion_id?: number;
  forum_cmid?: number;
  subject?: string;
  message: string;
  discussion_subscribe?: boolean;
}

interface ForumPostChangeArgs extends FileArgs {
  forum_cmid: number;
  post_id: number;
  action: 'edit' | 'delete';
  subject?: string;
  message?: string;
  keep_existing_files?: boolean;
  discussion_subscribe?: boolean;
}

const fileFields = {
  name: z.string().min(1).max(200).describe('File name including extension, e.g. "report.pdf".'),
  text: z.string().describe('Text content of the file (for text-like files).').optional(),
  content_base64: z.string().describe('Base64 content of the file (small binary files).').optional(),
};

/** files[]: local paths allowed in stdio only. */
function filesArg(stdio: boolean, what: string) {
  const local = z.object({
    ...fileFields,
    path: z.string().describe('Absolute path of a local file to upload.').optional(),
  });
  const file: z.ZodType<FileArg> = stdio ? local : z.object(fileFields);
  return z.array(file).max(10).describe(`Files to ${what}. Each needs exactly one of its content fields.`).optional();
}

/** Upload ids from create_upload_link exist on the Worker only. */
function withUploadId<T extends z.ZodRawShape>(base: z.ZodObject<T>, stdio: boolean) {
  if (stdio) return base;
  return base.extend({
    upload_id: z.string().describe('upload_id returned by create_upload_link after uploading the files.').optional(),
  });
}

const attachHint = (stdio: boolean) =>
  stdio
    ? 'Attach files with files[].path (absolute local path), files[].text or files[].content_base64. '
    : 'Attach small files inline (files[].text / content_base64) or larger ones via create_upload_link and upload_id. ';

function submissionInput(stdio: boolean): z.ZodType<SubmissionArgs> {
  const base = z.object({
    cmid: id('Assignment cmid (see get_activity).'),
    online_text: z
      .string()
      .describe('Online text answer in Markdown, for assignments that accept online text.')
      .optional(),
    files: filesArg(stdio, 'add to the submission'),
    keep_existing_files: z.boolean().describe('Keep files already in the current submission. Default true.').optional(),
    submit_for_grading: z.boolean().describe('Also finalize the submission (no more edits). Default true.').optional(),
    accept_statement: z
      .boolean()
      .describe('Only true if the user has read and accepted the submission statement shown by get_activity.')
      .optional(),
  });
  return withUploadId(base, stdio);
}

function toInlineFile(f: FileArg): InlineFile {
  const out: InlineFile = { name: f.name };
  if (f.text !== undefined) out.text = f.text;
  if (f.content_base64 !== undefined) out.contentBase64 = f.content_base64;
  if (f.path !== undefined) out.path = f.path;
  return out;
}

function prepareSubmissionTool(stdio: boolean) {
  return defineTool({
    name: 'prepare_submission',
    title: 'Prepare assignment submission',
    description:
      'Step 1 of 2: validates a submission against the assignment rules (open window, file types, limits, word count, statement) and returns a PREVIEW; nothing is submitted yet. ' +
      'Show the preview, including warnings, to the user and call confirm_action only after the user explicitly agrees. ' +
      attachHint(stdio) +
      'Unless keep_existing_files is false, files already in the submission are kept.',
    annotations: PREPARE_HINTS,
    input: submissionInput(stdio),
    output: actionPreviewOut,
    async run(ctx, a) {
      const r = await prepareSubmission(ctx, {
        cmid: a.cmid,
        onlineText: a.online_text,
        files: a.files?.map(toInlineFile),
        uploadId: a.upload_id,
        keepExistingFiles: a.keep_existing_files,
        submitForGrading: a.submit_for_grading,
        acceptStatement: a.accept_statement,
      });
      return { text: renderActionPreview(r), data: r };
    },
  });
}

function forumPostInput(stdio: boolean): z.ZodType<ForumPostArgs> {
  const base = z.object({
    forum_type: z
      .enum(['forum', 'hsuforum'])
      .describe('Forum kind as shown by list_discussions: "forum" or "hsuforum".'),
    reply_to_post_id: id('post_id to reply to (from get_discussion). Use this OR forum_id.').optional(),
    forum_id: id(
      'forum_id to start a new discussion in (from list_discussions / get_activity; not the cmid). Use this OR reply_to_post_id.',
    ).optional(),
    discussion_id: id(
      'Discussion id of the post being replied to (from get_discussion). Required for hsuforum replies so the preview can name the post; ignored for new discussions.',
    ).optional(),
    forum_cmid: id(
      "Replies: forum_cmid of the post's forum (from list_discussions). Needed to attach files; also shows the forum's due and cut-off dates.",
    ).optional(),
    subject: z
      .string()
      .max(255)
      .describe('Subject. Required for a new discussion; replies default to "Re: ...".')
      .optional(),
    message: z.string().min(1).describe('Post body in plain text or simple Markdown.'),
    files: filesArg(stdio, 'attach (standard forums only)'),
    discussion_subscribe: z
      .boolean()
      .describe("Subscribe to this discussion's email notifications. Default: the forum's setting.")
      .optional(),
  });
  return withUploadId(base, stdio);
}

function prepareForumPostTool(stdio: boolean) {
  return defineTool({
    name: 'prepare_forum_post',
    title: 'Prepare forum post',
    description:
      'Step 1 of 2: prepares a forum post and returns a PREVIEW; nothing is posted yet. ' +
      'Start a new discussion with forum_id (from list_discussions or get_activity) and a subject, or reply with reply_to_post_id (from get_discussion). ' +
      "Posts can carry attachments within the forum's limits (standard forums only). " +
      attachHint(stdio) +
      (stdio ? '' : 'For create_upload_link use the forum cmid. ') +
      'Show the exact text to the user and call confirm_action only after they approve it. ' +
      'Posts are public to the class: never post on your own initiative.',
    annotations: PREPARE_HINTS,
    input: forumPostInput(stdio),
    output: actionPreviewOut,
    async run(ctx, a) {
      const r = await prepareForumPost(ctx, {
        forumType: a.forum_type,
        replyToPostId: a.reply_to_post_id,
        forumId: a.forum_id,
        discussionId: a.discussion_id,
        forumCmid: a.forum_cmid,
        subject: a.subject,
        message: a.message,
        files: a.files?.map(toInlineFile),
        uploadId: a.upload_id,
        discussionSubscribe: a.discussion_subscribe,
      });
      return { text: renderActionPreview(r), data: r };
    },
  });
}

function forumPostChangeInput(stdio: boolean): z.ZodType<ForumPostChangeArgs> {
  const base = z.object({
    forum_cmid: id('forum_cmid of the standard forum the post is in (from list_discussions).'),
    post_id: id('post_id of your own post (from get_discussion).'),
    action: z.enum(['edit', 'delete']).describe('"edit" changes the post; "delete" removes it.'),
    subject: z.string().max(255).describe('Edit: new subject. Omit to keep the current one.').optional(),
    message: z.string().min(1).describe('Edit: new body in plain text or simple Markdown. Omit to keep it.').optional(),
    files: filesArg(stdio, 'attach (edit only)'),
    keep_existing_files: z
      .boolean()
      .describe('Edit: keep the current attachments (same-named new files replace them). Default true.')
      .optional(),
    discussion_subscribe: z
      .boolean()
      .describe('Edit: the discussion subscription after saving (Moodle sets it on every edit). Default true.')
      .optional(),
  });
  return withUploadId(base, stdio);
}

function prepareForumPostChangeTool(stdio: boolean) {
  return defineTool({
    name: 'prepare_forum_post_change',
    title: 'Prepare forum post edit or delete',
    description:
      'Step 1 of 2: prepares editing (action "edit") or deleting (action "delete") one of the user\'s own posts in a standard forum and returns a PREVIEW with the current and the new content; nothing changes yet. ' +
      "Works only for the user's own posts within Moodle's editing time, and only for posts without replies; deleting the first post deletes the discussion. " +
      'Show the preview to the user and call confirm_action only after they agree.',
    annotations: PREPARE_HINTS,
    input: forumPostChangeInput(stdio),
    output: actionPreviewOut,
    async run(ctx, a) {
      const r = await prepareForumPostChange(ctx, {
        forumCmid: a.forum_cmid,
        postId: a.post_id,
        action: a.action,
        subject: a.subject,
        message: a.message,
        files: a.files?.map(toInlineFile),
        uploadId: a.upload_id,
        keepExistingFiles: a.keep_existing_files,
        discussionSubscribe: a.discussion_subscribe,
      });
      return { text: renderActionPreview(r), data: r };
    },
  });
}

const prepareForumSubscriptionTool = defineTool({
  name: 'prepare_forum_subscription',
  title: 'Prepare forum subscription',
  description:
    'Step 1 of 2: prepares subscribing to or unsubscribing from the email notifications of a standard forum (forum_cmid from list_discussions or get_activity) and returns a PREVIEW. ' +
    'Show it to the user and call confirm_action after they agree. ' +
    'Forums with mandatory subscription and Advanced Forums (hsuforum) cannot be changed.',
  annotations: PREPARE_HINTS,
  input: z.object({
    forum_cmid: id('cmid of the forum activity.'),
    subscribe: z.boolean().describe('true = subscribe, false = unsubscribe.'),
  }),
  output: actionPreviewOut,
  async run(ctx, a) {
    const r = await prepareForumSubscription(ctx, { forumCmid: a.forum_cmid, subscribe: a.subscribe });
    return { text: renderActionPreview(r), data: r };
  },
});

const prepareMessageTool = defineTool({
  name: 'prepare_message',
  title: 'Prepare Moodle message',
  description:
    'Step 1 of 2: prepares a Moodle message to an existing conversation (conversation_id) or a new private message to a user (to_user_id) and returns a PREVIEW; nothing is sent yet. ' +
    'Show the exact text and recipient to the user and call confirm_action only after they approve. ' +
    'Never message anyone without the user asking for it.',
  annotations: PREPARE_HINTS,
  input: z.object({
    conversation_id: id('Existing conversation (from list_messages). Use this OR to_user_id.').optional(),
    to_user_id: id('Moodle user id of the recipient. Use this OR conversation_id.').optional(),
    text: z.string().min(1).describe('Message text.'),
  }),
  output: actionPreviewOut,
  async run(ctx, a) {
    const r = await prepareMessage(ctx, { conversationId: a.conversation_id, toUserId: a.to_user_id, text: a.text });
    return { text: renderActionPreview(r), data: r };
  },
});

const prepareCompletionTool = defineTool({
  name: 'prepare_completion',
  title: 'Prepare completion mark',
  description:
    'Step 1 of 2: prepares marking an activity as done or not done, only for activities with manual completion, and returns a PREVIEW. ' +
    'Show it to the user and call confirm_action after they agree. ' +
    'Activities that complete automatically (e.g. after submitting) cannot be changed this way.',
  annotations: PREPARE_HINTS,
  input: z.object({
    cmid: id('Activity cmid.'),
    completed: z.boolean().describe('true = mark as done, false = mark as not done.'),
  }),
  output: actionPreviewOut,
  async run(ctx, a) {
    const r = await prepareCompletion(ctx, { cmid: a.cmid, completed: a.completed });
    return { text: renderActionPreview(r), data: r };
  },
});

const confirmActionTool = defineTool({
  name: 'confirm_action',
  title: 'Confirm action',
  description:
    'Step 2 of 2: executes a prepared action (submission, questionnaire answers, forum post, post edit or delete, forum subscription, message, completion mark, mark as read) in Moodle. ' +
    'Call it only after the user has seen the preview and clearly agreed in this conversation; never to "test" or on your own judgment. ' +
    'If the preview said the action must be approved in the console, this tool cannot do it.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  input: z.object({ action_id: z.string().min(1).describe('action_id from the prepare_* preview.') }),
  output: actionResultOut,
  async run(ctx, a) {
    const r = await confirmAction(ctx, a.action_id, 'mcp');
    return { text: renderActionResult(r), data: r };
  },
});

const cancelActionTool = defineTool({
  name: 'cancel_action',
  title: 'Cancel action',
  description:
    'Discards a prepared action that has not been executed, for example when the user declines the preview or wants changes. ' +
    'After cancelling, prepare a new action if needed. Already executed actions cannot be cancelled.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ action_id: z.string().min(1).describe('action_id from the prepare_* preview.') }),
  output: actionResultOut,
  async run(ctx, a) {
    const r = await cancelAction(ctx, a.action_id);
    return { text: renderActionResult(r), data: r };
  },
});

/** Write tools; the file-taking ones differ by mode (local paths in stdio, upload ids on the Worker). */
export const writeTools = (stdio: boolean) => [
  prepareSubmissionTool(stdio),
  prepareForumPostTool(stdio),
  prepareForumPostChangeTool(stdio),
  prepareForumSubscriptionTool,
  prepareMessageTool,
  prepareCompletionTool,
  prepareQuestionnaireTool,
  confirmActionTool,
  cancelActionTool,
];
