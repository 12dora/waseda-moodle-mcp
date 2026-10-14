import * as z from 'zod';
import { getDiscussion, listDiscussions } from '../../services/forums';
import { getConversation, listConversations, listNotifications } from '../../services/messages';
import { renderDiscussion, renderDiscussions } from '../render/forums';
import { renderConversation, renderConversations, renderNotifications } from '../render/messages';
import { defineTool, id, limit, READ_HINTS } from './define';

const listDiscussionsTool = defineTool({
  name: 'list_discussions',
  title: 'Forum discussions',
  description:
    "Lists recent forum discussions, newest first. With no filter it shows announcements from the user's current courses; " +
    'pass course_id for all forums of a course, or forum_cmid for one forum. Use since_days to limit how far back to look. ' +
    'Open a discussion with get_discussion using the forum_type and discussion_id on its line.',
  annotations: READ_HINTS,
  input: z.object({
    course_id: id('Only forums of this course.').optional(),
    forum_cmid: id('Only this forum (cmid of the forum activity).').optional(),
    since_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .describe('Only discussions modified within this many days.')
      .optional(),
    limit: limit('Maximum discussions. Default 20.', 50).optional(),
  }),
  async run(ctx, a) {
    const r = await listDiscussions(ctx, {
      courseId: a.course_id,
      forumCmid: a.forum_cmid,
      sinceDays: a.since_days,
      limit: a.limit,
    });
    return { text: renderDiscussions(r), data: r };
  },
});

const getDiscussionTool = defineTool({
  name: 'get_discussion',
  title: 'Discussion posts',
  description:
    'Reads all posts of one forum discussion, oldest first, and says whether the user may reply. ' +
    'Use the forum_type and discussion_id (and forum_cmid for hsuforum) shown by list_discussions or get_activity. ' +
    'To answer, use prepare_forum_post with the post_id you reply to.',
  annotations: READ_HINTS,
  input: z.object({
    forum_type: z
      .enum(['forum', 'hsuforum'])
      .describe('Forum kind as shown by list_discussions: "forum" or "hsuforum" (Advanced Forum).'),
    discussion_id: id('Discussion id from list_discussions.'),
    forum_cmid: id('Forum cmid; fills in forum and course names for hsuforum discussions.').optional(),
  }),
  async run(ctx, a) {
    const r = await getDiscussion(ctx, {
      forumType: a.forum_type,
      discussionId: a.discussion_id,
      forumCmid: a.forum_cmid,
    });
    return { text: renderDiscussion(r), data: r };
  },
});

const listMessagesTool = defineTool({
  name: 'list_messages',
  title: 'Message conversations',
  description:
    "Lists the user's Moodle message conversations (private chats and groups) with unread counts and the last message. " +
    'Use it to check whether teachers or classmates wrote to the user; open one with get_conversation. ' +
    'Set unread_only to see just conversations with unread messages.',
  annotations: READ_HINTS,
  input: z.object({
    unread_only: z.boolean().describe('Only conversations with unread messages. Default false.').optional(),
    limit: limit('Maximum conversations. Default 20.', 100).optional(),
  }),
  async run(ctx, a) {
    const r = await listConversations(ctx, { unreadOnly: a.unread_only, limit: a.limit });
    return { text: renderConversations(r), data: { conversations: r } };
  },
});

const getConversationTool = defineTool({
  name: 'get_conversation',
  title: 'Conversation messages',
  description:
    'Reads the latest messages of one conversation, oldest first. ' +
    'Use the conversation_id from list_messages. To answer, use prepare_message.',
  annotations: READ_HINTS,
  input: z.object({
    conversation_id: id('Conversation id from list_messages.'),
    limit: limit('Number of latest messages. Default 30.', 100).optional(),
  }),
  async run(ctx, a) {
    const r = await getConversation(ctx, a.conversation_id, { limit: a.limit });
    return { text: renderConversation(r), data: r };
  },
});

const listNotificationsTool = defineTool({
  name: 'list_notifications',
  title: 'Notifications',
  description:
    'Lists Moodle notifications (new grades, feedback, forum posts, deadline reminders), newest first, with the unread count. ' +
    'Use it for "anything new?" questions. Set unread_only to hide notifications already seen.',
  annotations: READ_HINTS,
  input: z.object({
    unread_only: z.boolean().describe('Only unread notifications. Default false.').optional(),
    limit: limit('Maximum notifications. Default 20.', 100).optional(),
  }),
  async run(ctx, a) {
    const r = await listNotifications(ctx, { unreadOnly: a.unread_only, limit: a.limit });
    return { text: renderNotifications(r), data: r };
  },
});

export const socialTools = [
  listDiscussionsTool,
  getDiscussionTool,
  listMessagesTool,
  getConversationTool,
  listNotificationsTool,
];
