import * as z from 'zod';
import { prepareMarkRead } from '../../services/actions';
import { renderActionPreview } from '../render/actions';
import { actionPreviewOut } from '../schemas/actions';
import { defineTool, id, PREPARE_HINTS } from './define';

const prepareMarkReadTool = defineTool({
  name: 'prepare_mark_read',
  title: 'Prepare mark as read',
  description:
    'Step 1 of 2: prepares marking notifications as read (notification_ids from list_notifications, or all_notifications), ' +
    'all messages of one conversation (conversation_id from list_messages) or all posts of one standard-forum discussion (forum_discussion_id with its forum_cmid, from list_discussions) as read and returns a PREVIEW; nothing changes yet. ' +
    'Give exactly one of the four. Show the preview to the user and call confirm_action only after they agree. ' +
    'This only clears unread markers; it never deletes anything.',
  annotations: PREPARE_HINTS,
  input: z.object({
    notification_ids: z
      .array(id('Notification id.'))
      .min(1)
      .max(30)
      .describe('Notification ids (from list_notifications), at most 30.')
      .optional(),
    all_notifications: z
      .boolean()
      .describe('Mark every notification as read. Use instead of notification_ids.')
      .optional(),
    conversation_id: id('Mark all messages of this conversation as read (from list_messages).').optional(),
    forum_discussion_id: id(
      'Mark all posts of this discussion as read (discussion_id of a forum_type "forum" discussion).',
    ).optional(),
    forum_cmid: id("forum_cmid of that discussion's forum (required with forum_discussion_id).").optional(),
  }),
  output: actionPreviewOut,
  async run(ctx, a) {
    const r = await prepareMarkRead(ctx, {
      notificationIds: a.notification_ids,
      allNotifications: a.all_notifications,
      conversationId: a.conversation_id,
      forumDiscussionId: a.forum_discussion_id,
      forumCmid: a.forum_cmid,
    });
    return { text: renderActionPreview(r), data: r };
  },
});

export const markReadTools = [prepareMarkReadTool];
