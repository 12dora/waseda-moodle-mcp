import * as z from 'zod';
import { GMAIL_ID_RE } from '../../mail/gmail';
import { getMail, searchMail } from '../../services/mail/read';
import { renderMail, renderMailSearch } from '../render/mail';
import { getMailOut, searchMailOut } from '../schemas/mail';
import { defineTool, limit, READ_HINTS } from './define';

const gmailId = (describe: string) => z.string().regex(GMAIL_ID_RE).describe(describe);

const searchMailTool = defineTool({
  name: 'search_mail',
  title: 'Search Waseda mail',
  description:
    "Searches the user's Waseda university mailbox (Wasedaメール, Gmail) — not Moodle messages (list_messages). " +
    'query uses Gmail search syntax (from:, subject:, is:unread, has:attachment, after:2026/11/01, newer_than:7d); ' +
    'default in:inbox; newest first.',
  annotations: READ_HINTS,
  input: z.object({
    query: z
      .string()
      .max(500)
      .describe(
        'Gmail search syntax (from:, subject:, is:unread, has:attachment, after:2026/11/01, newer_than:7d). ' +
          'Default in:inbox.',
      )
      .optional(),
    limit: limit('Maximum messages. Default 10.', 20).optional(),
    page_token: z
      .string()
      .max(200)
      .describe('From nextPageToken of the previous search_mail result, to fetch the next page.')
      .optional(),
  }),
  output: searchMailOut,
  async run(ctx, a) {
    const r = await searchMail(ctx, { query: a.query, limit: a.limit, pageToken: a.page_token });
    return { text: renderMailSearch(r), data: r };
  },
});

const getMailTool = defineTool({
  name: 'get_mail',
  title: 'Read Waseda mail',
  description:
    'Reads one Waseda university mailbox message or thread (Wasedaメール, Gmail) — not a Moodle conversation ' +
    '(get_conversation). Pass thread_id from search_mail, or message_id from get_mail — exactly one. ' +
    'Reading does not mark the mail as read (the Gmail API never does). ' +
    'A thread keeps the newest 10 messages; older ones are counted in omitted. ' +
    'Attachments come as short-lived download links; if your sandbox blocks them (HTTP 403), the result says what the user must allow.',
  annotations: READ_HINTS,
  input: z.object({
    message_id: gmailId('Gmail message id from get_mail (hex). Pass this or thread_id, not both.').optional(),
    thread_id: gmailId('Gmail thread id from search_mail (hex). Pass this or message_id, not both.').optional(),
  }),
  output: getMailOut,
  async run(ctx, a) {
    const r = await getMail(ctx, { messageId: a.message_id, threadId: a.thread_id });
    return { text: renderMail(r), data: r };
  },
});

export const mailReadTools = [searchMailTool, getMailTool];
