import * as z from 'zod';
import { list } from './common';

export const forumSearchOut = z.looseObject({
  query: z.string(),
  hits: list({
    forumType: z.string(),
    courseId: z.number(),
    discussionId: z.number(),
    subject: z.string(),
    snippet: z.string(),
    inSubject: z.boolean(),
  }),
  perForum: z.number(),
  skippedForums: z.number(),
  /** null = messages were not requested. */
  messages: list({ name: z.string(), text: z.string(), fromMe: z.boolean() }).nullable(),
  messagesNote: z.string().nullable(),
});
