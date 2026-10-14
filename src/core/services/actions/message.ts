/** Direct messages: to an existing conversation or straight to a user. */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput } from '../../errors';
import { decodeEntities } from '../../html';
import type { ActionPreview } from '../../types';
import {
  type ActionOutcome,
  assertWriteAllowed,
  isRec,
  isSet,
  num,
  positiveInt,
  type Raw,
  requireText,
  savePreview,
  str,
  truncate,
  tryCall,
} from './shared';
import { plainTextToHtml } from './text';

const MAX_MESSAGE_CHARS = 4000;

export interface PrepareMessageInput {
  conversationId?: number;
  toUserId?: number;
  text: string;
}

type MessagePayload = {
  conversationId: number | null;
  toUserId: number | null;
  text: string;
};

/** Conversation name, or the other members' names for unnamed (private) conversations. */
function conversationName(conversation: Raw | null, myId: number): string | null {
  if (!conversation) return null;
  const name = str(conversation.name);
  if (name) return name;
  const members = Array.isArray(conversation.members) ? conversation.members : [];
  const others = members.filter((m): m is Raw => isRec(m) && num(m.id) !== myId);
  return (
    others
      .map((m) => str(m.fullname))
      .filter(Boolean)
      .join(', ') || null
  );
}

async function conversationRecipient(api: MoodleApi, conversationId: number): Promise<string> {
  const r = await tryCall<Raw>(api, 'core_message_get_conversation', {
    userid: api.moodleUserId,
    conversationid: conversationId,
    includecontactrequests: 0,
    includeprivacyinfo: 0,
    memberlimit: 5,
    memberoffset: 0,
    messagelimit: 0,
    messageoffset: 0,
    newestmessagesfirst: 1,
  });
  const name = conversationName(r, api.moodleUserId);
  return name ? decodeEntities(name) : `conversation ${conversationId}`;
}

async function userRecipient(api: MoodleApi, userId: number): Promise<string> {
  const r = await tryCall<unknown>(api, 'core_user_get_users_by_field', { field: 'id', values: [userId] });
  const user = Array.isArray(r) && isRec(r[0]) ? r[0] : null;
  const name = user ? str(user.fullname) : null;
  return name ? decodeEntities(name) : `user ${userId}`;
}

export async function prepareMessage(ctx: ServiceContext, input: PrepareMessageInput): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  if (isSet(input.conversationId) === isSet(input.toUserId)) {
    throw new InvalidInput('Provide either conversation_id or to_user_id.');
  }
  const text = requireText(input.text, 'message', MAX_MESSAGE_CHARS);
  const api = await ctx.moodle();
  const conversationId = input.conversationId ?? null;
  const toUserId = isSet(input.toUserId) ? positiveInt(input.toUserId, 'to_user_id') : null;
  if (toUserId === ctx.user.moodleUserId) throw new InvalidInput('You cannot message yourself.');
  const recipient =
    toUserId === null
      ? await conversationRecipient(api, positiveInt(conversationId, 'conversation_id'))
      : await userRecipient(api, toUserId);
  const payload: MessagePayload = { conversationId, toUserId, text };
  return savePreview(ctx, {
    kind: 'message',
    title: `Message to ${recipient}`,
    details: [`To: ${recipient}`, `Message: ${truncate(text, 1500)}`],
    warnings: ['Messages cannot be unsent.'],
    payload,
  });
}

// ------------------------------------------------------------------ execute

async function sendInstant(api: MoodleApi, toUserId: number | null, html: string): Promise<void> {
  const res = await api.call<unknown>('core_message_send_instant_messages', {
    messages: [{ touserid: toUserId, text: html, textformat: 1 }],
  });
  const first = Array.isArray(res) && isRec(res[0]) ? res[0] : null;
  if (first && (num(first.msgid) === -1 || str(first.errormessage))) {
    throw new InvalidInput(`Moodle did not send the message: ${str(first.errormessage) ?? 'unknown reason'}`);
  }
}

export async function executeMessage(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as MessagePayload;
  const html = plainTextToHtml(p.text);
  if (p.conversationId === null) {
    await sendInstant(api, p.toUserId, html);
  } else {
    await api.call('core_message_send_messages_to_conversation', {
      conversationid: p.conversationId,
      messages: [{ text: html, textformat: 1 }],
    });
  }
  return { message: 'Message sent.', url: null };
}
