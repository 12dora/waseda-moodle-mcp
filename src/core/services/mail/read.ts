/**
 * Waseda mailbox reads: Gmail search (metadata) and a single message or thread (full).
 * Attachment download tickets (`k: 'ml'`) are minted here; the HTTP route lives in file-http.ts.
 */

import type { MailApi, MailQuery, ServiceContext } from '../../context';
import { InvalidInput, NotFound } from '../../errors';
import { decodeEntities } from '../../html';
import { requireMail } from '../../mail/connection';
import { GMAIL_ID_RE, type GmailMessage, type GmailThread, gmailWebUrl, header } from '../../mail/gmail';
import { isoJst } from '../../time';
import { DOWNLOAD_TTL_SEC } from '../files';
import { clampInt } from '../shared';
import { parseMailBody, type RawMailAttachment } from './body';

const META_CONCURRENCY = 5;
const KEEP_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_CALL_CHARS = 40_000;
const DEFAULT_QUERY = 'in:inbox';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

/** Over this, the ticket url is null and the model is told to open the file in Gmail (Workers Free CPU). */
export const MAIL_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export interface MailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  url: string | null;
  note: string | null;
}

export interface MailMessage {
  id: string;
  date: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  unread: boolean;
  text: string;
  truncated: boolean;
  note: string | null;
  attachments: MailAttachment[];
}

export interface MailThread {
  threadId: string;
  subject: string;
  webUrl: string;
  omitted: number;
  messages: MailMessage[];
}

export interface MailSearchHit {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  unread: boolean;
  hasAttachments: boolean;
  webUrl: string;
}

export interface MailSearchResult {
  messages: MailSearchHit[];
  nextPageToken: string | null;
  resultSizeEstimate: number;
}

function dateOf(internalDate: string | undefined): string {
  const ms = Number(internalDate);
  return Number.isFinite(ms) ? isoJst(ms) : '';
}

function unreadOf(m: GmailMessage): boolean {
  return (m.labelIds ?? []).includes('UNREAD');
}

function hdr(m: GmailMessage, name: string): string {
  return header(m.payload, name) ?? '';
}

function byInternalDate(a: GmailMessage, b: GmailMessage): number {
  return Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0);
}

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, Math.max(0, end));
}

function capOne(m: MailMessage, max: number): MailMessage {
  if (m.text.length <= max) return m;
  return { ...m, text: clipText(m.text, max), truncated: true };
}

function trimOldest(messages: MailMessage[], total: number): MailMessage[] {
  const out = messages.slice();
  let left = total;
  for (let i = 0; i < out.length && left > MAX_CALL_CHARS; i++) {
    const m = out[i];
    if (!m) continue;
    const keep = Math.max(0, m.text.length - (left - MAX_CALL_CHARS));
    if (keep >= m.text.length) continue;
    left -= m.text.length - keep;
    out[i] = { ...m, text: clipText(m.text, keep), truncated: true };
  }
  return out;
}

function applyLimits(messages: MailMessage[]): MailMessage[] {
  const capped = messages.map((m) => capOne(m, MAX_MESSAGE_CHARS));
  let total = 0;
  for (const m of capped) total += m.text.length;
  return total <= MAX_CALL_CHARS ? capped : trimOldest(capped, total);
}

async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await fn(item);
    }
  };
  if (items.length === 0) return [];
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

function mapHit(address: string, m: GmailMessage): MailSearchHit {
  return {
    id: m.id,
    threadId: m.threadId,
    date: dateOf(m.internalDate),
    from: hdr(m, 'From'),
    to: hdr(m, 'To'),
    subject: hdr(m, 'Subject'),
    snippet: decodeEntities(m.snippet ?? ''),
    unread: unreadOf(m),
    hasAttachments: m.payload?.mimeType === 'multipart/mixed',
    webUrl: gmailWebUrl(address, m.id),
  };
}

interface ListResponse {
  messages?: Array<{ id?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

const META_QUERY: MailQuery = { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] };

async function metaOrSkip(api: MailApi, id: string): Promise<GmailMessage | null> {
  try {
    return await api.get<GmailMessage>(`messages/${id}`, META_QUERY);
  } catch (e) {
    if (e instanceof NotFound) return null;
    throw e;
  }
}

export async function searchMail(
  ctx: ServiceContext,
  opts: { query?: string; limit?: number; pageToken?: string } = {},
): Promise<MailSearchResult> {
  const api = await requireMail(ctx);
  const q = opts.query?.trim() || DEFAULT_QUERY;
  const query: MailQuery = { q, maxResults: clampInt(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT) };
  if (opts.pageToken) query.pageToken = opts.pageToken;
  const list = await api.get<ListResponse>('messages', query);
  const ids = (list.messages ?? []).flatMap((m) => (m.id ? [m.id] : []));
  const details = await mapPool(ids, META_CONCURRENCY, (id) => metaOrSkip(api, id));
  return {
    messages: details.flatMap((m) => (m ? [mapHit(api.address, m)] : [])),
    nextPageToken: list.nextPageToken ?? null,
    resultSizeEstimate: list.resultSizeEstimate ?? 0,
  };
}

function requireGmailId(value: string, name: string): string {
  if (!GMAIL_ID_RE.test(value)) throw new InvalidInput(`${name} is not a valid Gmail id.`);
  return value;
}

type MailPick = { kind: 'message'; id: string } | { kind: 'thread'; id: string };

function pickMailId(opts: { messageId?: string; threadId?: string }): MailPick {
  const messageId = opts.messageId?.trim() || undefined;
  const threadId = opts.threadId?.trim() || undefined;
  if (messageId) {
    if (threadId) throw new InvalidInput('Pass exactly one of message_id or thread_id.');
    return { kind: 'message', id: requireGmailId(messageId, 'message_id') };
  }
  if (threadId) return { kind: 'thread', id: requireGmailId(threadId, 'thread_id') };
  throw new InvalidInput('Pass exactly one of message_id or thread_id.');
}

async function fetchThread(api: MailApi, threadId: string): Promise<GmailThread> {
  const t = await api.get<GmailThread>(`threads/${threadId}`, { format: 'full' });
  return { id: t.id, messages: t.messages ?? [] };
}

async function fetchMessageAsThread(api: MailApi, messageId: string): Promise<GmailThread> {
  const m = await api.get<GmailMessage>(`messages/${messageId}`, { format: 'full' });
  return { id: m.threadId, messages: [m] };
}

async function signAttachment(ctx: ServiceContext, messageId: string, raw: RawMailAttachment): Promise<MailAttachment> {
  const base = { filename: raw.filename, mimeType: raw.mimeType, size: raw.size };
  if (raw.size > MAIL_ATTACHMENT_MAX_BYTES) return { ...base, url: null, note: 'Open it in Gmail.' };
  const ticket = await ctx.signer.sign(
    { k: 'ml', u: ctx.user.id, m: messageId, a: raw.attachmentId, n: raw.filename, t: raw.mimeType, s: raw.size },
    DOWNLOAD_TTL_SEC,
  );
  return { ...base, url: `${ctx.publicUrl}/f/${ticket}`, note: null };
}

async function mapMessage(ctx: ServiceContext, m: GmailMessage): Promise<MailMessage> {
  const body = parseMailBody(m.payload);
  const attachments: MailAttachment[] = [];
  for (const raw of body.attachments) attachments.push(await signAttachment(ctx, m.id, raw));
  return {
    id: m.id,
    date: dateOf(m.internalDate),
    from: hdr(m, 'From'),
    to: hdr(m, 'To'),
    cc: hdr(m, 'Cc'),
    subject: hdr(m, 'Subject'),
    unread: unreadOf(m),
    text: body.text,
    truncated: false,
    note: body.note,
    attachments,
  };
}

async function buildThreadView(ctx: ServiceContext, address: string, thread: GmailThread): Promise<MailThread> {
  const sorted = (thread.messages ?? []).slice().sort(byInternalDate);
  const omitted = Math.max(0, sorted.length - KEEP_MESSAGES);
  const kept = sorted.slice(omitted);
  const first = sorted[0];
  const messages: MailMessage[] = [];
  for (const m of kept) messages.push(await mapMessage(ctx, m));
  return {
    threadId: thread.id,
    subject: first ? hdr(first, 'Subject') : '',
    webUrl: gmailWebUrl(address, thread.id),
    omitted,
    messages: applyLimits(messages),
  };
}

export async function getMail(
  ctx: ServiceContext,
  opts: { messageId?: string; threadId?: string },
): Promise<MailThread> {
  const api = await requireMail(ctx);
  const pick = pickMailId(opts);
  const thread = pick.kind === 'thread' ? await fetchThread(api, pick.id) : await fetchMessageAsThread(api, pick.id);
  return buildThreadView(ctx, api.address, thread);
}
