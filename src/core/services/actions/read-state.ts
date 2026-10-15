/** Mark notifications (some, or all) or one conversation as read. */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput, MoodleError, NotFound } from '../../errors';
import { decodeEntities } from '../../html';
import type { ActionPreview } from '../../types';
import { fetchConversationInfo, mapConversation } from '../messages';
import type { RawNotification } from '../messages/notifications';
import {
  type ActionOutcome,
  assertWriteAllowed,
  hasWarnings,
  isSet,
  num,
  positiveInt,
  type Raw,
  refusal,
  savePreview,
  tryCall,
} from './shared';

/** Each id is one Moodle call; the confirm request has a 50-subrequest budget. */
const MAX_NOTIFICATION_IDS = 30;
const SUBJECT_LOOKUP_WINDOW = 100;

interface PrepareMarkReadInput {
  notificationIds?: number[];
  allNotifications?: boolean;
  conversationId?: number;
}

type MarkReadPayload = {
  notificationIds: number[] | null;
  allNotifications: boolean;
  conversationId: number | null;
};

interface Target {
  title: string;
  details: string[];
  warnings: string[];
  payload: MarkReadPayload;
}

function validIds(ids: unknown): number[] {
  if (!Array.isArray(ids) || ids.length === 0) throw new InvalidInput('notification_ids must be a non-empty list.');
  const unique = [...new Set(ids.map((v) => positiveInt(v, 'notification_ids entry')))];
  if (unique.length > MAX_NOTIFICATION_IDS) {
    throw new InvalidInput(
      `At most ${MAX_NOTIFICATION_IDS} notifications at a time; use all_notifications for the rest.`,
    );
  }
  return unique;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function missingWarning(missing: number): string[] {
  if (missing === 0) return [];
  const ids = missing === 1 ? '1 id was' : `${missing} ids were`;
  return [`${ids} not found in your latest ${SUBJECT_LOOKUP_WINDOW} notifications.`];
}

async function notificationsTarget(api: MoodleApi, ids: number[]): Promise<Target> {
  const feed = await tryCall<{ notifications?: RawNotification[] | null }>(
    api,
    'message_popup_get_popup_notifications',
    { useridto: api.moodleUserId, newestfirst: true, limit: SUBJECT_LOOKUP_WINDOW, offset: 0 },
  );
  const subjects = new Map((feed?.notifications ?? []).map((n) => [n.id, decodeEntities(n.subject ?? '')]));
  const lines = ids.filter((i) => subjects.has(i)).map((i) => subjects.get(i) || `notification ${i}`);
  const older = ids.filter((i) => !subjects.has(i));
  if (older.length > 0) lines.push(`${plural(older.length, 'older notification')} (ids ${older.join(', ')})`);
  return {
    title: `Mark ${plural(ids.length, 'notification')} as read`,
    details: [`Notifications: ${ids.length}`, ...lines],
    warnings: feed ? missingWarning(older.length) : [],
    payload: { notificationIds: ids, allNotifications: false, conversationId: null },
  };
}

async function allNotificationsTarget(api: MoodleApi): Promise<Target> {
  const unread = await tryCall<unknown>(api, 'core_message_get_unread_notification_count', {
    useridto: api.moodleUserId,
  });
  const count = num(unread);
  return {
    title: 'Mark all notifications as read',
    details: [count === null ? 'All notifications' : `All notifications (${count} unread)`],
    warnings: count === 0 ? ['There are no unread notifications.'] : [],
    payload: { notificationIds: null, allNotifications: true, conversationId: null },
  };
}

async function conversationTarget(ctx: ServiceContext, api: MoodleApi, conversationId: number): Promise<Target> {
  const info = await fetchConversationInfo(api, ctx.user.moodleUserId, conversationId);
  if (!info) throw new NotFound(`Conversation ${conversationId} was not found.`);
  const label = mapConversation(info, ctx.user.moodleUserId).name || `conversation ${conversationId}`;
  return {
    title: `Mark '${label}' as read`,
    details: [`Conversation: ${label}`, 'Marks all its messages as read.'],
    warnings: info.unreadcount === 0 ? ['This conversation has no unread messages.'] : [],
    payload: { notificationIds: null, allNotifications: false, conversationId },
  };
}

async function resolveTarget(ctx: ServiceContext, api: MoodleApi, input: PrepareMarkReadInput): Promise<Target> {
  if (input.allNotifications === true) return allNotificationsTarget(api);
  if (isSet(input.conversationId)) {
    return conversationTarget(ctx, api, positiveInt(input.conversationId, 'conversation_id'));
  }
  return notificationsTarget(api, validIds(input.notificationIds));
}

export async function prepareMarkRead(ctx: ServiceContext, input: PrepareMarkReadInput): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  const modes = [isSet(input.notificationIds), input.allNotifications === true, isSet(input.conversationId)];
  if (modes.filter(Boolean).length !== 1) {
    throw new InvalidInput('Provide exactly one of notification_ids, all_notifications or conversation_id.');
  }
  const { title, details, warnings, payload } = await resolveTarget(ctx, await ctx.moodle(), input);
  return savePreview(ctx, { kind: 'mark_read', title, details, warnings, payload });
}

// ------------------------------------------------------------------ execute

/** Marks each id read; individual refusals are collected so one stale id does not hide the rest. */
async function markNotifications(api: MoodleApi, ids: number[]): Promise<string> {
  const failed: number[] = [];
  for (const id of ids) {
    try {
      const res = await api.call<Raw>('core_message_mark_notification_read', { notificationid: id });
      if (hasWarnings(res)) failed.push(id);
    } catch (e) {
      if (!(e instanceof MoodleError)) throw e;
      failed.push(id);
    }
  }
  if (failed.length === ids.length) throw refusal('did not mark any of the notifications as read', null);
  if (failed.length === 0) return `Marked ${plural(ids.length, 'notification')} as read.`;
  const done = ids.length - failed.length;
  return `Marked ${done} of ${ids.length} notifications as read; Moodle refused ids ${failed.join(', ')}.`;
}

export async function executeMarkRead(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as MarkReadPayload;
  if (p.notificationIds) return { message: await markNotifications(api, p.notificationIds), url: null };
  if (p.conversationId !== null) {
    await api.call('core_message_mark_all_conversation_messages_as_read', {
      userid: api.moodleUserId,
      conversationid: p.conversationId,
    });
    return { message: 'Conversation marked as read.', url: null };
  }
  await api.call('core_message_mark_all_notifications_as_read', { useridto: api.moodleUserId });
  return { message: 'All notifications marked as read.', url: null };
}
