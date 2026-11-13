import * as z from 'zod';
import { list } from './common';

const discussionSummary = {
  forumType: z.string(),
  forumId: z.number(),
  forumKind: z.string(),
  courseId: z.number(),
  courseName: z.string(),
  discussionId: z.number(),
  subject: z.string(),
  canCreateDiscussions: z.boolean(),
};

export const discussionsOut = z.looseObject({
  forums: list({ forumId: z.number(), forumKind: z.string(), canCreateDiscussions: z.boolean() }),
  discussions: list(discussionSummary),
  skippedForums: z.number(),
  truncatedForums: list({ forumId: z.number(), nextPage: z.number(), pageSize: z.number() }),
});

export const discussionOut = z.looseObject({
  summary: z.looseObject(discussionSummary),
  posts: list({
    id: z.number(),
    parentId: z.number().nullable(),
    author: z.string(),
    message: z.string(),
    createdAt: z.string().nullable(),
    unread: z.boolean(),
    canReply: z.boolean(),
    attachments: list({ name: z.string(), url: z.string() }),
  }),
  canReply: z.boolean(),
  forumIntro: z.string(),
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
