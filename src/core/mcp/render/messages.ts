import type { ConversationPage } from '../../services/messages';
import type { NotificationPage } from '../../services/messages/notifications';
import type { PeopleResult, Person } from '../../services/messages/people';
import { fmt } from '../../time';
import type { ConversationSummary, Notification } from '../../types';
import { assemble, assembleTail, clip, oneLine, plural } from './common';

function conversationLine(c: ConversationSummary): string {
  const last = c.lastMessage ? ` — last: "${oneLine(c.lastMessage, 80)}" (${fmt(c.lastAt)})` : '';
  const unread = c.unread ? ` — ${c.unread} unread` : '';
  return `- ${oneLine(c.name, 60)} (${c.type}) — conversation_id ${c.id}${unread}${last}`;
}

/** `nextOffset`: offset of the next page when the list may continue. */
export function renderConversations(list: ConversationSummary[], nextOffset?: number | null): string {
  if (list.length === 0) return 'No conversations found.';
  return assemble({
    head: [`${plural(list.length, 'conversation')} (open one with get_conversation):`],
    entries: list.map((c) => ({ text: conversationLine(c), item: true })),
    footer: nextOffset ? [`More: call list_messages again with offset ${nextOffset}.`] : [],
    hint: 'lower limit or use unread_only',
  });
}

export function renderConversation(c: ConversationPage): string {
  const members = c.members.map((m) => `${oneLine(m.name, 40)} (user_id ${m.id})`).join(', ');
  const head = [
    `# ${oneLine(c.summary.name, 80)} — conversation_id ${c.summary.id} (${c.summary.type})`,
    `Members: ${clip(members, 400)}`,
    c.messages.length ? `${plural(c.messages.length, 'message')}, oldest first:` : 'No messages.',
  ];
  const blocks = c.messages.map(
    (m) => `[${fmt(m.sentAt)}] ${m.fromMe ? 'You' : oneLine(m.author, 40)}: ${clip(m.text, 500)}`,
  );
  const footer = [`Reply with prepare_message (conversation_id ${c.summary.id}).`];
  if (c.nextOffset !== null) footer.push(`Older messages: call get_conversation with offset ${c.nextOffset}.`);
  return assembleTail({ head, blocks, footer, noun: c.messages.length === 1 ? 'message' : 'messages' });
}

function notificationLine(n: Notification): string {
  const text = n.text ? ` — ${oneLine(n.text, 160)}` : '';
  const sender = n.sender ? ` (${oneLine(n.sender, 40)})` : '';
  const source = n.component ? `id ${n.id}, ${n.component}` : `id ${n.id}`;
  const url = n.url ? ` — ${n.url}` : '';
  const subject = oneLine(n.subject, 100);
  return `- ${n.read ? '' : '[unread] '}${fmt(n.sentAt)} — ${subject}${text}${sender} [${source}]${url}`;
}

export function renderNotifications(r: NotificationPage): string {
  const summary = `${r.unreadCount} unread notification${r.unreadCount === 1 ? '' : 's'}.`;
  if (r.notifications.length === 0) return `${summary} Nothing to show.`;
  return assemble({
    head: [summary],
    entries: r.notifications.map((n) => ({ text: notificationLine(n), item: true })),
    footer: r.nextOffset === null ? [] : [`Older: call list_notifications again with offset ${r.nextOffset}.`],
    hint: 'lower limit or use unread_only',
  });
}

function personLine(p: Person): string {
  const where = [...p.courses, ...(p.inConversation ? ['conversation'] : [])].join(', ');
  const role = p.announcements ? ' — posts announcements (likely a teacher)' : '';
  return `- ${oneLine(p.name, 60)} — user_id ${p.id}${role} — seen in: ${oneLine(where, 120)}`;
}

export function renderPeople(r: PeopleResult): string {
  const query = oneLine(r.query, 60);
  const footer =
    r.skippedForums > 0
      ? [`(${plural(r.skippedForums, 'forum')} not checked; pass course_id to look at one course.)`]
      : [];
  if (r.people.length === 0) {
    const reach = 'Only people who posted in your course forums or share a conversation with you can be found.';
    return [`No people found for "${query}". ${reach}`, ...footer].join('\n');
  }
  const found = `${plural(r.people.length, 'person', 'people')} for "${query}"`;
  return assemble({
    head: [`${found} (message one with prepare_message to_user_id):`],
    entries: r.people.map((p) => ({ text: personLine(p), item: true })),
    footer,
    hint: 'narrow the search',
  });
}
