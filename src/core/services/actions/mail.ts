/** Waseda mailbox send / reply: prepare a preview, then execute through Gmail after confirm. */

import type { MailApi, ServiceContext } from '../../context';
import { InvalidInput } from '../../errors';
import { assertCanSend, requireMail } from '../../mail/connection';
import { decodeMimeWords, GMAIL_ID_RE, type GmailMessage, type GmailPart, gmailWebUrl, header } from '../../mail/gmail';
import { buildMessage, formatMailbox, type Mailbox, parseAddressList, rejectNl, requireMailbox } from '../../mail/mime';
import type { ActionKind, ActionPreview } from '../../types';
import { type ActionOutcome, assertWriteAllowed, previewText, type Raw, requireText, savePreview } from './shared';

export type MailKind = 'mail_send' | 'mail_reply';

export const isMailKind = (kind: ActionKind): kind is MailKind => kind === 'mail_send' || kind === 'mail_reply';

const MAX_TO = 20;
const MAX_CC = 20;
const MAX_SUBJECT = 200;
const MAX_BODY = 20_000;
const RE_PREFIX = /^(re|aw|回复|返信)\s*[:：]/i;
const REPLY_HEADERS = ['From', 'Reply-To', 'To', 'Cc', 'Subject', 'Message-ID', 'References'] as const;
const MAILBOX_CHANGED = 'The connected mailbox changed since this mail was prepared. Prepare it again.';

interface PrepareMailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

interface PrepareMailReplyInput {
  messageId: string;
  body: string;
  replyAll?: boolean;
  cc?: string[];
}

type SendPayload = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
};

type ReplyPayload = {
  from: string;
  messageId: string;
  threadId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  inReplyTo: string;
  references: string;
};

type MailFields = { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function display(m: Mailbox): string {
  return formatMailbox({ name: collapseWs(m.name), address: m.address }, false);
}

function parseInputList(items: string[] | undefined, label: string, max: number, required: boolean): Mailbox[] {
  if (!items) {
    if (required) throw new InvalidInput(`The ${label} list is empty.`);
    return [];
  }
  const out: Mailbox[] = [];
  for (const raw of items) {
    const item = typeof raw === 'string' ? raw.trim() : '';
    if (!item) continue;
    out.push(requireMailbox(item, label));
  }
  if (out.length === 0 && (required || items.length > 0)) {
    throw new InvalidInput(`The ${label} list is empty.`);
  }
  if (out.length > max) throw new InvalidInput(`Too many ${label} addresses (max ${max}).`);
  return out;
}

function requireHeaderText(v: unknown, label: string, max: number): string {
  const text = requireText(v, label, max);
  rejectNl(text, label);
  return text;
}

function requireGmailId(v: unknown, label: string): string {
  if (typeof v !== 'string' || !GMAIL_ID_RE.test(v)) throw new InvalidInput(`The ${label} is not a valid mail id.`);
  return v;
}

function mailTitle(kind: MailKind, n: number): string {
  const who = plural(n, 'recipient');
  return kind === 'mail_send' ? `Send mail to ${who}` : `Reply to mail (${who})`;
}

function mailDetails(from: string, p: MailFields): string[] {
  const lines = [`From: ${from}`, `To: ${p.to.join(', ')}`];
  if (p.cc?.length) lines.push(`Cc: ${p.cc.join(', ')}`);
  if (p.bcc?.length) lines.push(`Bcc: ${p.bcc.join(', ')}`);
  lines.push(`Subject: ${p.subject}`, `Body: ${previewText(p.body)}`);
  return lines;
}

async function mailClient(ctx: ServiceContext): Promise<MailApi> {
  const api = await requireMail(ctx);
  assertWriteAllowed(ctx);
  assertCanSend(api);
  return api;
}

function recipientCount(p: MailFields): number {
  return p.to.length + (p.cc?.length ?? 0) + (p.bcc?.length ?? 0);
}

function saveMailPreview(
  ctx: ServiceContext,
  kind: MailKind,
  payload: SendPayload | ReplyPayload,
): Promise<ActionPreview> {
  return savePreview(ctx, {
    kind,
    title: mailTitle(kind, recipientCount(payload)),
    details: mailDetails(payload.from, payload),
    warnings: ['Sent mail cannot be recalled.'],
    payload,
  });
}

export async function prepareMailSend(ctx: ServiceContext, input: PrepareMailSendInput): Promise<ActionPreview> {
  const api = await mailClient(ctx);
  const payload: SendPayload = {
    from: api.address,
    to: parseInputList(input.to, 'to', MAX_TO, true).map(display),
    cc: parseInputList(input.cc, 'cc', MAX_CC, false).map(display),
    bcc: parseInputList(input.bcc, 'bcc', MAX_CC, false).map(display),
    subject: requireHeaderText(input.subject, 'subject', MAX_SUBJECT),
    body: requireText(input.body, 'body', MAX_BODY),
  };
  return saveMailPreview(ctx, 'mail_send', payload);
}

function takeMailboxes(list: Mailbox[], self: string, seen: Set<string>): Mailbox[] {
  const selfKey = self.toLowerCase();
  const out: Mailbox[] = [];
  for (const m of list) {
    const key = m.address.toLowerCase();
    if (!key || key === selfKey || seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

interface ReplyPeople {
  primary: Mailbox[];
  originalTo: Mailbox[];
  originalCc: Mailbox[];
  extraCc: Mailbox[];
  replyAll: boolean;
  self: string;
}

/** When Reply-To/From is only self (reply to a sent message), fall back to the original To. */
function replyToSource(p: ReplyPeople): Mailbox[] {
  const others = takeMailboxes(p.primary, p.self, new Set());
  if (others.length === 0) return p.originalTo;
  return p.replyAll ? [...p.primary, ...p.originalTo] : p.primary;
}

function replyRecipients(p: ReplyPeople): { to: Mailbox[]; cc: Mailbox[] } {
  const seen = new Set<string>();
  const source = replyToSource(p);
  const to = takeMailboxes(source, p.self, seen);
  // a mail you sent only to yourself: the reply goes to yourself, as in Gmail
  // (only when you are the sender: an announcement from undisclosed-recipients must not loop back to you)
  const isSelf = (m: Mailbox) => m.address.toLowerCase() === p.self.toLowerCase();
  const me = to.length === 0 && p.primary.some(isSelf) ? source.find(isSelf) : undefined;
  if (me) {
    to.push(me);
    seen.add(me.address.toLowerCase());
  }
  const ccSrc = p.replyAll ? [...p.originalCc, ...p.extraCc] : p.extraCc;
  return { to, cc: takeMailboxes(ccSrc, p.self, seen) };
}

function replySubject(subject: string | null): string {
  const s = collapseWs(subject ?? '');
  return RE_PREFIX.test(s) ? s : `Re: ${s}`;
}

function replyReferences(refs: string | null, messageId: string | null): string {
  const ids = `${refs ?? ''} ${messageId ?? ''}`.trim().split(/\s+/).filter(Boolean);
  return ids.slice(-20).join(' ');
}

async function loadReplyMessage(api: MailApi, messageId: string): Promise<GmailMessage> {
  return api.get<GmailMessage>(`messages/${messageId}`, {
    format: 'metadata',
    metadataHeaders: [...REPLY_HEADERS],
  });
}

function rawHeader(part: GmailPart | undefined, name: string): string {
  const lower = name.toLowerCase();
  return part?.headers?.find((x) => x.name.toLowerCase() === lower)?.value ?? '';
}

function decodeMailbox(m: Mailbox): Mailbox {
  return { name: decodeMimeWords(m.name), address: m.address };
}

function headerMailboxes(part: GmailPart | undefined, name: string): Mailbox[] {
  return parseAddressList(rawHeader(part, name)).map(decodeMailbox);
}

function replyPrimary(part: GmailPart | undefined): Mailbox[] {
  const replyTo = headerMailboxes(part, 'Reply-To');
  return replyTo.length > 0 ? replyTo : headerMailboxes(part, 'From');
}

function buildReplyPayload(opts: {
  self: string;
  messageId: string;
  msg: GmailMessage;
  body: string;
  extraCc: Mailbox[];
  replyAll: boolean;
}): ReplyPayload {
  const part = opts.msg.payload;
  const { to, cc } = replyRecipients({
    primary: replyPrimary(part),
    originalTo: headerMailboxes(part, 'To'),
    originalCc: headerMailboxes(part, 'Cc'),
    extraCc: opts.extraCc,
    replyAll: opts.replyAll,
    self: opts.self,
  });
  if (to.length === 0) throw new InvalidInput('No recipients to reply to.');
  const threadId = opts.msg.threadId;
  if (!threadId) throw new InvalidInput('This mail has no thread.');
  const messageIdHeader = header(part, 'Message-ID');
  return {
    from: opts.self,
    messageId: opts.messageId,
    threadId,
    to: to.map(display),
    cc: cc.map(display),
    subject: replySubject(header(part, 'Subject')),
    body: opts.body,
    inReplyTo: collapseWs(messageIdHeader ?? ''),
    references: replyReferences(header(part, 'References'), messageIdHeader),
  };
}

export async function prepareMailReply(ctx: ServiceContext, input: PrepareMailReplyInput): Promise<ActionPreview> {
  const api = await mailClient(ctx);
  const messageId = requireGmailId(input.messageId, 'message_id');
  const payload = buildReplyPayload({
    self: api.address,
    messageId,
    msg: await loadReplyMessage(api, messageId),
    body: requireText(input.body, 'body', MAX_BODY),
    extraCc: parseInputList(input.cc, 'cc', MAX_CC, false),
    replyAll: input.replyAll === true,
  });
  return saveMailPreview(ctx, 'mail_reply', payload);
}

function assertSameFrom(api: MailApi, from: string | undefined): void {
  if (!from || from.toLowerCase() !== api.address.toLowerCase()) throw new InvalidInput(MAILBOX_CHANGED);
}

async function dispatchMail(
  api: MailApi,
  parts: Parameters<typeof buildMessage>[0],
  threadId?: string,
): Promise<ActionOutcome> {
  const raw = buildMessage(parts);
  const sent = await api.post<GmailMessage>('messages/send', threadId ? { raw, threadId } : { raw });
  return { message: 'Mail sent.', url: sent.id ? gmailWebUrl(api.address, sent.id) : null };
}

export async function executeMailSend(api: MailApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as SendPayload;
  assertSameFrom(api, p.from);
  return dispatchMail(api, { to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, body: p.body });
}

export async function executeMailReply(api: MailApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as ReplyPayload;
  assertSameFrom(api, p.from);
  return dispatchMail(
    api,
    { to: p.to, cc: p.cc, subject: p.subject, body: p.body, inReplyTo: p.inReplyTo, references: p.references },
    p.threadId,
  );
}
