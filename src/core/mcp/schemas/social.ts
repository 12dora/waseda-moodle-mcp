import * as z from 'zod';
import { list } from './common';

const discussionSummary = {
  forumType: z.string(),
  forumId: z.number(),
  courseId: z.number(),
  courseName: z.string(),
  discussionId: z.number(),
  subject: z.string(),
};

export const discussionsOut = z.looseObject({ discussions: list(discussionSummary), skippedForums: z.number() });

export const discussionOut = z.looseObject({
  summary: z.looseObject(discussionSummary),
  posts: list({ id: z.number(), parentId: z.number().nullable(), author: z.string(), message: z.string() }),
  canReply: z.boolean(),
});

const conversationSummary = { id: z.number(), name: z.string(), type: z.string() };

export const conversationsOut = z.looseObject({
  conversations: list({ ...conversationSummary, unread: z.number(), memberIds: z.array(z.number()) }),
});

export const conversationOut = z.looseObject({
  summary: z.looseObject(conversationSummary),
  messages: list({ id: z.number(), author: z.string(), fromMe: z.boolean(), text: z.string() }),
  members: list({ id: z.number(), name: z.string() }),
  nextOffset: z.number().nullable(),
});

export const notificationsOut = z.looseObject({
  notifications: list({
    id: z.number(),
    subject: z.string(),
    read: z.boolean(),
    url: z.string().nullable(),
    component: z.string().nullable(),
  }),
  unreadCount: z.number(),
  nextOffset: z.number().nullable(),
});

export const peopleOut = z.looseObject({
  query: z.string(),
  people: list({ id: z.number(), name: z.string() }),
  skippedForums: z.number(),
});
