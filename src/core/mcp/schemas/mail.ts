import * as z from 'zod';
import { list } from './common';

export const searchMailOut = z.looseObject({
  messages: list({
    id: z.string(),
    threadId: z.string(),
    date: z.string(),
    from: z.string(),
    subject: z.string(),
  }),
  nextPageToken: z.string().nullable(),
  resultSizeEstimate: z.number(),
});

export const getMailOut = z.looseObject({
  threadId: z.string(),
  subject: z.string(),
  webUrl: z.string(),
  omitted: z.number(),
  messages: list({
    id: z.string(),
    date: z.string(),
    from: z.string(),
    subject: z.string(),
    unread: z.boolean(),
    text: z.string(),
    truncated: z.boolean(),
    attachments: list({ filename: z.string() }),
  }),
});
