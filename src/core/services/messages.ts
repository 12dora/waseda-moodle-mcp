/** Private messages (conversations) and popup notifications. */

import type { MoodleApi, ServiceContext } from '../context';
import { MoodleError, NotFound } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import { fromTs } from '../time';
import type { Conversation, ConversationSummary, Message, Notification } from '../types';
import { clampInt } from './shared';

// ------------------------------------------------------------------ raw Moodle shapes (loose)

interface RawMember {
  id: number;
  fullname?: string | null;
}

interface RawPreviewMessage {
  id?: number;
  text?: string | null;
  timecreated?: number | null;
}

export interface RawConversation {
  id: number;
  name?: string | null;
  type?: number | null; // 1 individual, 2 group, 3 self
  unreadcount?: number | null;
  members?: RawMember[] | null;
  messages?: RawPreviewMessage[] | null;
}

interface RawMessage {
  id: number;
  useridfrom: number;
  text?: string | null;
  timecreated?: number | null;
}

export interface RawConversationMessages {
  id?: number;
  members?: RawMember[] | null;
  messages?: RawMessage[] | null;
}

export interface RawNotification {
  id: number;
  useridfrom?: number | null;
  subject?: string | null;
  text?: string | null;
  fullmessage?: string | null;
  fullmessagehtml?: string | null;
  smallmessage?: string | null;
  contexturl?: string | null;
  timecreated?: number | null;
  read?: boolean | null;
  component?: string | null;
}

const NOTIFICATION_MAX_CHARS = 600;
const PREVIEW_MAX_CHARS = 200;

const TYPES: Record<number, ConversationSummary['type']> = { 1: 'private', 2: 'group', 3: 'self' };

// ------------------------------------------------------------------ conversations

function conversationName(
  raw: RawConversation,
  type: ConversationSummary['type'],
  members: RawMember[],
  selfId: number,
): string {
  const named = decodeEntities(raw.name ?? '').trim();
  if (named) return named;
  if (type === 'self') return 'Personal space';
  return members
    .filter((m) => m.id !== selfId)
    .map((m) => decodeEntities(m.fullname ?? ''))
    .filter(Boolean)
    .join(', ');
}

export function mapConversation(raw: RawConversation, selfMoodleId: number): ConversationSummary {
  const type = TYPES[raw.type ?? 1] ?? 'private';
  const members = raw.members ?? [];
  const last = raw.messages?.[0];
  return {
    id: raw.id,
    name: conversationName(raw, type, members, selfMoodleId),
    type,
    unread: raw.unreadcount ?? 0,
    lastMessage: last?.text ? htmlToMarkdown(last.text, { maxChars: PREVIEW_MAX_CHARS }) || null : null,
    lastAt: fromTs(last?.timecreated),
    memberIds: members.map((m) => m.id),
  };
}

export async function listConversations(
  ctx: ServiceContext,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<ConversationSummary[]> {
  const limit = clampInt(opts.limit, 20, 1, 100);
  const api = await ctx.moodle();
  const selfId = ctx.user.moodleUserId;
  // unread filtering is client-side, so read a wider window than the requested limit
  const res = await api.call<{ conversations?: RawConversation[] | null }>('core_message_get_conversations', {
    userid: selfId,
    limitfrom: 0,
    limitnum: opts.unreadOnly ? Math.max(limit, 50) : limit,
  });
  let list = (res?.conversations ?? []).map((c) => mapConversation(c, selfId));
  if (opts.unreadOnly) list = list.filter((c) => c.unread > 0);
  return list.slice(0, limit);
}

function mapMessages(raw: RawConversationMessages, self: { moodleUserId: number; fullname: string }): Message[] {
  const nameOf = new Map((raw.members ?? []).map((m) => [m.id, decodeEntities(m.fullname ?? '')]));
  return [...(raw.messages ?? [])]
    .sort((a, b) => (a.timecreated ?? 0) - (b.timecreated ?? 0) || a.id - b.id)
    .map((m): Message => {
      const fromMe = m.useridfrom === self.moodleUserId;
      return {
        id: m.id,
        author: (fromMe ? self.fullname : nameOf.get(m.useridfrom)) || nameOf.get(m.useridfrom) || '',
        fromMe,
        sentAt: fromTs(m.timecreated) ?? '',
        text: htmlToMarkdown(m.text),
      };
    });
}

/** Without `core_message_get_conversation` the type follows from the member count (a 2-person group looks private). */
function inferTypeCode(memberCount: number): number {
  if (memberCount <= 1) return 3;
  return memberCount === 2 ? 1 : 2;
}

/** Conversation header from `core_message_get_conversation` (type, name, unread); null when that call fails. */
async function fetchConversationInfo(
  api: MoodleApi,
  selfId: number,
  conversationId: number,
): Promise<RawConversation | null> {
  return api
    .call<RawConversation>('core_message_get_conversation', {
      userid: selfId,
      conversationid: conversationId,
      includecontactrequests: false,
      includeprivacyinfo: false,
      memberlimit: 0,
      memberoffset: 0,
      messagelimit: 0,
      messageoffset: 0,
      newestmessagesfirst: true,
    })
    .catch((e: unknown) => {
      if (e instanceof MoodleError) return null;
      throw e;
    });
}

function conversationSummary(
  info: RawConversation | null,
  res: RawConversationMessages,
  selfId: number,
  conversationId: number,
): ConversationSummary {
  const members = info?.members?.length ? info.members : (res.members ?? []);
  return mapConversation(
    {
      id: conversationId,
      name: info?.name,
      type: info?.type ?? inferTypeCode(members.length),
      unreadcount: info?.unreadcount,
      members,
    },
    selfId,
  );
}

export async function getConversation(
  ctx: ServiceContext,
  conversationId: number,
  opts: { limit?: number } = {},
): Promise<Conversation> {
  const limit = clampInt(opts.limit, 30, 1, 100);
  const api = await ctx.moodle();
  const selfId = ctx.user.moodleUserId;
  const fetchMessages = api
    .call<RawConversationMessages>('core_message_get_conversation_messages', {
      currentuserid: selfId,
      convid: conversationId,
      limitfrom: 0,
      limitnum: limit,
      newest: true,
    })
    .catch((e: unknown) => {
      if (e instanceof MoodleError && /conversation/i.test(`${e.errorcode} ${e.message}`)) {
        throw new NotFound(`Conversation ${conversationId} was not found.`);
      }
      throw e;
    });
  const [res, info] = await Promise.all([fetchMessages, fetchConversationInfo(api, selfId, conversationId)]);
  const messages = mapMessages(res ?? {}, { moodleUserId: selfId, fullname: ctx.user.fullname });
  const last = messages[messages.length - 1];
  const summary = conversationSummary(info, res ?? {}, selfId, conversationId);
  return {
    summary: {
      ...summary,
      lastMessage: last ? last.text.slice(0, PREVIEW_MAX_CHARS) || null : null,
      lastAt: last?.sentAt || null,
    },
    messages,
  };
}

// ------------------------------------------------------------------ notifications

/** Notification mails wrap the message in a navbar/header; keep only the message itself. */
function stripChrome(html: string): string {
  return html
    .replace(/<(header|nav)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<div\b[^>]*\bclass="[^"]*\bnavbar\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
}

/** smallmessage (short, HTML-escaped) first, then the plain-text fullmessage, then the HTML mail body. */
function notificationText(raw: RawNotification): string {
  if (raw.smallmessage) return htmlToMarkdown(raw.smallmessage, { maxChars: NOTIFICATION_MAX_CHARS });
  const plain = raw.fullmessage?.trim();
  if (plain) {
    return plain.length > NOTIFICATION_MAX_CHARS ? `${plain.slice(0, NOTIFICATION_MAX_CHARS)}…` : plain;
  }
  return htmlToMarkdown(stripChrome(raw.fullmessagehtml || raw.text || ''), { maxChars: NOTIFICATION_MAX_CHARS });
}

export function mapNotification(raw: RawNotification): Notification {
  return {
    id: raw.id,
    subject: decodeEntities(raw.subject ?? ''),
    text: notificationText(raw),
    sender: null, // the popup feed carries only the sender id
    sentAt: fromTs(raw.timecreated) ?? '',
    read: raw.read === true,
    url: raw.contexturl || null,
    component: raw.component || null,
  };
}

export async function listNotifications(
  ctx: ServiceContext,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<{ notifications: Notification[]; unreadCount: number }> {
  const limit = clampInt(opts.limit, 20, 1, 100);
  const api = await ctx.moodle();
  // the popup feed has no unread filter, so read a wider window when only unread ones are wanted
  const res = await api.call<{ notifications?: RawNotification[] | null; unreadcount?: number | null }>(
    'message_popup_get_popup_notifications',
    {
      useridto: ctx.user.moodleUserId,
      newestfirst: true,
      limit: opts.unreadOnly ? Math.min(100, limit * 3) : limit,
      offset: 0,
    },
  );
  let list = (res?.notifications ?? []).map(mapNotification);
  if (opts.unreadOnly) list = list.filter((n) => !n.read);
  return {
    notifications: list.slice(0, limit),
    unreadCount: res?.unreadcount ?? list.filter((n) => !n.read).length,
  };
}
