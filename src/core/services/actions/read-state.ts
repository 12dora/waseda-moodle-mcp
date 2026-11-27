/** Mark notifications (some, or all), one conversation or one forum discussion as read. */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput, MoodleError, NotFound } from '../../errors';
import { decodeEntities } from '../../html';
import type { ActionPreview } from '../../types';
import { fetchConversationInfo, mapConversation } from '../messages';
import type { RawNotification } from '../messages/notifications';
import { type DiscussionEntry, loadForumThread, lookupForumPost, requireDiscussion, resolveForum } from './forum-info';
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
const NO_TARGET: MarkReadPayload = {
  notificationIds: null,
  allNotifications: false,
  conversationId: null,
  forumDiscussion: null,
};

interface PrepareMarkReadInput {
  notificationIds?: number[];
  allNotifications?: boolean;
  conversationId?: number;
  forumDiscussionId?: number;
  /** The forum activity of forumDiscussionId (required with it). */
  forumCmid?: number;
}

type MarkReadPayload = {
  notificationIds: number[] | null;
  allNotifications: boolean;
  conversationId: number | null;
  /** Absent in rows prepared before forum targets existed. */
  forumDiscussion?: { discussionId: number } | null;
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
    payload: { ...NO_TARGET, notificationIds: ids },
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
    payload: { ...NO_TARGET, allNotifications: true },
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
    payload: { ...NO_TARGET, conversationId },
  };
}

/**
 * Subject and read-marking mode of the discussion's first post. The web channel can show a post only to someone who
 * may edit or reply to it (announcements: neither) and does not see manual marking at all, so there the discussion
 * list's subject stands in for it.
 */
type FirstPost = { subject: string | null; manualRead: boolean };

async function firstPost(api: MoodleApi, entry: DiscussionEntry): Promise<FirstPost> {
  const post = entry.firstPostId === null ? null : await lookupForumPost(api, entry.firstPostId);
  if (post) return post;
  if (api.channel === 'web' && entry.subject) return { subject: entry.subject, manualRead: false };
  throw new NotFound(`Discussion ${entry.id} could not be read.`);
}

/**
 * Standard forums only. Prepare reads the discussion list and its first post, which mark nothing read; the confirmed
 * action then reads the posts and calls mod_forum_mark_posts_read.
 */
async function forumDiscussionTarget(api: MoodleApi, forumCmid: number, discussionId: number): Promise<Target> {
  const forum = await resolveForum(api, forumCmid, 'forum');
  if (!forum.settings || forum.settings.tracked === null) {
    throw new InvalidInput("Could not read this forum's settings. Try again.");
  }
  if (!forum.settings.tracked) {
    throw new InvalidInput('This forum does not track read posts, so there is nothing to mark.');
  }
  const entry = await requireDiscussion(api, forum, discussionId);
  const first = await firstPost(api, entry);
  if (first.manualRead) {
    throw new InvalidInput(
      'This site marks forum posts read by hand, which the Moodle web service cannot do. Use the Moodle site.',
    );
  }
  const label = first.subject ?? `discussion ${discussionId}`;
  return {
    title: `Mark '${label}' as read`,
    details: [`Discussion: ${label}`, `Unread posts: ${entry.numUnread} of ${entry.numReplies + 1}`],
    warnings: entry.numUnread === 0 ? ['This discussion has no unread posts.'] : [],
    payload: { ...NO_TARGET, forumDiscussion: { discussionId } },
  };
}

async function resolveTarget(ctx: ServiceContext, api: MoodleApi, input: PrepareMarkReadInput): Promise<Target> {
  if (input.allNotifications === true) return allNotificationsTarget(api);
  if (isSet(input.conversationId)) {
    return conversationTarget(ctx, api, positiveInt(input.conversationId, 'conversation_id'));
  }
  if (isSet(input.forumDiscussionId)) {
    if (!isSet(input.forumCmid)) throw new InvalidInput('forum_discussion_id needs forum_cmid (see list_discussions).');
    const cmid = positiveInt(input.forumCmid, 'forum_cmid');
    return forumDiscussionTarget(api, cmid, positiveInt(input.forumDiscussionId, 'forum_discussion_id'));
  }
  return notificationsTarget(api, validIds(input.notificationIds));
}

export async function prepareMarkRead(ctx: ServiceContext, input: PrepareMarkReadInput): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  const modes = [
    isSet(input.notificationIds),
    input.allNotifications === true,
    isSet(input.conversationId),
    isSet(input.forumDiscussionId),
  ];
  if (modes.filter(Boolean).length !== 1) {
    throw new InvalidInput(
      'Provide exactly one of notification_ids, all_notifications, conversation_id or forum_discussion_id.',
    );
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
  if (p.forumDiscussion) {
    const { discussionId } = p.forumDiscussion;
    const thread = await loadForumThread(api, discussionId);
    if (!thread || thread.posts.length === 0) throw new InvalidInput('Could not read the discussion. Try again.');
    const postids = thread.unread.length > 0 ? thread.unread : thread.posts.map((x) => x.id);
    const done = await api.call<unknown>('mod_forum_mark_posts_read', { postids, discussionid: discussionId });
    if (done !== true) throw refusal('did not mark the posts as read (read tracking may be off in this forum)', null);
    return { message: 'Discussion marked as read.', url: `${api.baseUrl}/mod/forum/discuss.php?d=${discussionId}` };
  }
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
