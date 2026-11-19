import * as z from 'zod';
import { GMAIL_ID_RE } from '../../mail/gmail';
import { prepareMailReply, prepareMailSend } from '../../services/actions';
import { renderActionPreview } from '../render/actions';
import { actionPreviewOut } from '../schemas/actions';
import { defineTool, PREPARE_HINTS, type ToolDef } from './define';

const mailbox = z.string().min(1).max(200).describe('Email address, or Name <address>.');

const prepareMailSendTool = defineTool({
  name: 'prepare_mail_send',
  title: 'Prepare a Waseda mail',
  description:
    "Step 1 of 2: prepares a mail from the user's Waseda mailbox (Wasedaメール, Gmail) and returns a PREVIEW; " +
    'nothing is sent yet. This is not a Moodle message (use prepare_message for those). ' +
    'Show the preview to the user and call confirm_action only after they agree, or they approve it in the console. ' +
    'Never send mail without the user asking for it.',
  annotations: PREPARE_HINTS,
  input: z.object({
    to: z.array(mailbox).min(1).max(20).describe('To addresses (1–20).'),
    cc: z.array(mailbox).max(20).describe('Cc addresses (at most 20).').optional(),
    bcc: z.array(mailbox).max(20).describe('Bcc addresses (at most 20).').optional(),
    subject: z.string().min(1).max(200).describe('Subject (plain text).'),
    body: z.string().min(1).max(20_000).describe('Body (plain text).'),
  }),
  output: actionPreviewOut,
  async run(ctx, a) {
    const r = await prepareMailSend(ctx, {
      to: a.to,
      cc: a.cc,
      bcc: a.bcc,
      subject: a.subject,
      body: a.body,
    });
    return { text: renderActionPreview(r), data: r };
  },
});

const prepareMailReplyTool = defineTool({
  name: 'prepare_mail_reply',
  title: 'Prepare a Waseda mail reply',
  description:
    "Step 1 of 2: prepares a reply from the user's Waseda mailbox (Wasedaメール, Gmail) to an existing mail " +
    '(message_id from search_mail / get_mail) and returns a PREVIEW; nothing is sent yet. ' +
    'This is not a Moodle message (use prepare_message for those). reply_all includes the original To and Cc ' +
    '(minus the user). Show the preview to the user and call confirm_action only after they agree, or they ' +
    'approve it in the console.',
  annotations: PREPARE_HINTS,
  input: z.object({
    message_id: z.string().regex(GMAIL_ID_RE).describe('Gmail message id from search_mail or get_mail.'),
    body: z.string().min(1).max(20_000).describe('Reply body (plain text).'),
    reply_all: z.boolean().describe('Include the original To and Cc. Default false.').optional(),
    cc: z.array(mailbox).max(20).describe('Extra Cc addresses (appended).').optional(),
  }),
  output: actionPreviewOut,
  async run(ctx, a) {
    const r = await prepareMailReply(ctx, {
      messageId: a.message_id,
      body: a.body,
      replyAll: a.reply_all,
      cc: a.cc,
    });
    return { text: renderActionPreview(r), data: r };
  },
});

export const mailWriteTools: ToolDef[] = [prepareMailSendTool, prepareMailReplyTool];
