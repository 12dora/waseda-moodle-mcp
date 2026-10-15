import * as z from 'zod';
import { getDiscussion, listDiscussions } from '../../services/forums';
import { getConversation, listConversations } from '../../services/messages';
import { listNotifications } from '../../services/messages/notifications';
import { searchPeople } from '../../services/messages/people';
import { renderDiscussion, renderDiscussions } from '../render/forums';
import { renderConversation, renderConversations, renderNotifications, renderPeople } from '../render/messages';
import {
  conversationOut,
  conversationsOut,
  discussionOut,
  discussionsOut,
  notificationsOut,
  peopleOut,
} from '../schemas/social';
import { defineTool, id, limit, READ_HINTS } from './define';

const offset = (describe: string) => z.number().int().min(0).max(10_000).describe(describe);
const DEFAULT_LIST_LIMIT = 20;

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
  output: discussionsOut,
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
  output: discussionOut,
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
    'Set unread_only to see just conversations with unread messages, type to restrict to private chats, groups or the personal space, ' +
    'and offset to page further back.',
  annotations: READ_HINTS,
  input: z.object({
    unread_only: z.boolean().describe('Only conversations with unread messages. Default false.').optional(),
    type: z.enum(['private', 'group', 'self']).describe('Only this kind of conversation.').optional(),
    limit: limit('Maximum conversations. Default 20.', 100).optional(),
    offset: offset('Conversations to skip (paging). Default 0.').optional(),
  }),
  output: conversationsOut,
  async run(ctx, a) {
    const r = await listConversations(ctx, {
      unreadOnly: a.unread_only,
      type: a.type,
      limit: a.limit,
      offset: a.offset,
    });
    // the unread filter is applied after paging, so only unfiltered lists have a reliable next offset
    const full = !a.unread_only && r.length >= (a.limit ?? DEFAULT_LIST_LIMIT);
    return { text: renderConversations(r, full ? (a.offset ?? 0) + r.length : null), data: { conversations: r } };
  },
});

const getConversationTool = defineTool({
  name: 'get_conversation',
  title: 'Conversation messages',
  description:
    'Reads the latest messages of one conversation, oldest first, with its members (user ids). ' +
    'Use the conversation_id from list_messages. For older messages pass the offset the output names. ' +
    'To answer, use prepare_message.',
  annotations: READ_HINTS,
  input: z.object({
    conversation_id: id('Conversation id from list_messages.'),
    limit: limit('Number of messages per page. Default 30.', 100).optional(),
    offset: offset('Newest messages to skip (paging; use the offset the output names). Default 0.').optional(),
  }),
  output: conversationOut,
  async run(ctx, a) {
    const r = await getConversation(ctx, a.conversation_id, { limit: a.limit, offset: a.offset });
    return { text: renderConversation(r), data: r };
  },
});

const listNotificationsTool = defineTool({
  name: 'list_notifications',
  title: 'Notifications',
  description:
    'Lists Moodle notifications (new grades, feedback, forum posts, deadline reminders), newest first, with the unread count, ' +
    'each with its id, component and link. Use it for "anything new?" questions. Set unread_only to hide notifications already seen ' +
    'and offset to page further back. To clear them use prepare_mark_read.',
  annotations: READ_HINTS,
  input: z.object({
    unread_only: z.boolean().describe('Only unread notifications. Default false.').optional(),
    limit: limit('Maximum notifications. Default 20.', 100).optional(),
    offset: offset('Feed entries to skip (paging; use the offset the output names). Default 0.').optional(),
  }),
  output: notificationsOut,
  async run(ctx, a) {
    const r = await listNotifications(ctx, { unreadOnly: a.unread_only, limit: a.limit, offset: a.offset });
    return { text: renderNotifications(r), data: r };
  },
});

const searchPeopleTool = defineTool({
  name: 'search_people',
  title: 'Search people',
  description:
    "Finds teachers and classmates who posted in the user's course forums or share a conversation with them, by name " +
    '(Japanese or romaji; every word must match). Announcement authors, most likely teachers, come first. ' +
    'Use the ids with prepare_message to_user_id.',
  annotations: READ_HINTS,
  input: z.object({
    query: z.string().min(1).max(100).describe('Part of the name to search for, e.g. "OZAKI" or "尾崎".'),
    course_id: id('Only people who posted in the forums of this course (conversations are not searched).').optional(),
    limit: limit('Maximum people. Default 20.', 50).optional(),
  }),
  output: peopleOut,
  async run(ctx, a) {
    const r = await searchPeople(ctx, { query: a.query, courseId: a.course_id, limit: a.limit });
    return { text: renderPeople(r), data: r };
  },
});

export const socialTools = [
  listDiscussionsTool,
  getDiscussionTool,
  listMessagesTool,
  getConversationTool,
  listNotificationsTool,
  searchPeopleTool,
];
