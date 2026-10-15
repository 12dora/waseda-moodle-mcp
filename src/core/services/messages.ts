/** Private messages (conversations) and popup notifications. */

import type { MoodleApi, ServiceContext } from '../context';
import { MoodleError, NotFound } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import { fromTs } from '../time';
import type { Conversation, ConversationSummary, Message } from '../types';
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

const TYPE_CODES: Record<ConversationSummary['type'], number> = { private: 1, group: 2, self: 3 };

export async function listConversations(
  ctx: ServiceContext,
  opts: { unreadOnly?: boolean; limit?: number; offset?: number; type?: ConversationSummary['type'] } = {},
): Promise<ConversationSummary[]> {
  const limit = clampInt(opts.limit, 20, 1, 100);
  const api = await ctx.moodle();
  const selfId = ctx.user.moodleUserId;
  // unread filtering is client-side, so read a wider window than the requested limit
  const res = await api.call<{ conversations?: RawConversation[] | null }>('core_message_get_conversations', {
    userid: selfId,
    limitfrom: clampInt(opts.offset, 0, 0, 10_000),
    limitnum: opts.unreadOnly ? Math.max(limit, 50) : limit,
    ...(opts.type ? { type: TYPE_CODES[opts.type] } : {}),
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

/** Conversation header from `core_message_get_conversation` (type, name, unread, newest message); null on failure. */
export async function fetchConversationInfo(
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
      messagelimit: 1,
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
      messages: info?.messages,
    },
    selfId,
  );
}

const MAX_MEMBERS = 50;

export interface ConversationPage extends Conversation {
  /** At most 50 members (the first ones Moodle lists). */
  members: { id: number; name: string }[];
  /** `offset` that fetches the next older page; null when the history is exhausted. */
  nextOffset: number | null;
}

interface GetConversationOptions {
  limit?: number;
  /** Messages to skip, newest first. */
  offset?: number;
}

function fetchRawMessages(
  api: MoodleApi,
  req: { selfId: number; conversationId: number; offset: number; limit: number },
): Promise<RawConversationMessages> {
  return api
    .call<RawConversationMessages>('core_message_get_conversation_messages', {
      currentuserid: req.selfId,
      convid: req.conversationId,
      limitfrom: req.offset,
      limitnum: req.limit,
      newest: true,
    })
    .catch((e: unknown) => {
      if (e instanceof MoodleError && /conversation/i.test(`${e.errorcode} ${e.message}`)) {
        throw new NotFound(`Conversation ${req.conversationId} was not found.`);
      }
      throw e;
    });
}

/**
 * The conversation's last message comes from its header, so a page far back in the history does not
 * pass an old message off as the latest one; without it only the newest page can tell.
 */
function withLatest(summary: ConversationSummary, messages: Message[], offset: number): ConversationSummary {
  if (summary.lastAt) return summary;
  const last = offset === 0 ? messages[messages.length - 1] : undefined;
  if (!last) return summary;
  return { ...summary, lastMessage: last.text.slice(0, PREVIEW_MAX_CHARS) || null, lastAt: last.sentAt || null };
}

export async function getConversation(
  ctx: ServiceContext,
  conversationId: number,
  opts: GetConversationOptions = {},
): Promise<ConversationPage> {
  const limit = clampInt(opts.limit, 30, 1, 100);
  const api = await ctx.moodle();
  const selfId = ctx.user.moodleUserId;
  const offset = clampInt(opts.offset, 0, 0, 10_000);
  const [fetched, info] = await Promise.all([
    fetchRawMessages(api, { selfId, conversationId, offset, limit }),
    fetchConversationInfo(api, selfId, conversationId),
  ]);
  const res = fetched ?? {};
  const messages = mapMessages(res, { moodleUserId: selfId, fullname: ctx.user.fullname });
  const summary = conversationSummary(info, res, selfId, conversationId);
  const members = (info?.members?.length ? info.members : (res.members ?? [])).slice(0, MAX_MEMBERS);
  return {
    summary: withLatest({ ...summary, memberIds: summary.memberIds.slice(0, MAX_MEMBERS) }, messages, offset),
    messages,
    members: members.map((m) => ({ id: m.id, name: decodeEntities(m.fullname ?? '') })),
    nextOffset: messages.length >= limit ? offset + messages.length : null,
  };
}
