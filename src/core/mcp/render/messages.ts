import { fmt } from '../../time';
import type { Conversation, ConversationSummary, Notification } from '../../types';
import { assemble, assembleTail, clip, oneLine, plural } from './common';

function conversationLine(c: ConversationSummary): string {
  const last = c.lastMessage ? ` — last: "${oneLine(c.lastMessage, 80)}" (${fmt(c.lastAt)})` : '';
  const unread = c.unread ? ` — ${c.unread} unread` : '';
  return `- ${oneLine(c.name, 60)} (${c.type}) — conversation_id ${c.id}${unread}${last}`;
}

export function renderConversations(list: ConversationSummary[]): string {
  if (list.length === 0) return 'No conversations found.';
  return assemble({
    head: [`${plural(list.length, 'conversation')} (open one with get_conversation):`],
    entries: list.map((c) => ({ text: conversationLine(c), item: true })),
    hint: 'lower limit or use unread_only',
  });
}

export function renderConversation(c: Conversation): string {
  const head = [
    `# ${oneLine(c.summary.name, 80)} — conversation_id ${c.summary.id} (${c.summary.type})`,
    c.messages.length ? `${plural(c.messages.length, 'message')}, oldest first:` : 'No messages.',
  ];
  const blocks = c.messages.map(
    (m) => `[${fmt(m.sentAt)}] ${m.fromMe ? 'You' : oneLine(m.author, 40)}: ${clip(m.text, 500)}`,
  );
  return assembleTail({ head, blocks, noun: c.messages.length === 1 ? 'message' : 'messages' });
}

function notificationLine(n: Notification): string {
  const text = n.text ? ` — ${oneLine(n.text, 160)}` : '';
  const sender = n.sender ? ` (${oneLine(n.sender, 40)})` : '';
  return `- ${n.read ? '' : '[unread] '}${fmt(n.sentAt)} — ${oneLine(n.subject, 100)}${text}${sender}`;
}

export function renderNotifications(r: { notifications: Notification[]; unreadCount: number }): string {
  const summary = `${r.unreadCount} unread notification${r.unreadCount === 1 ? '' : 's'}.`;
  if (r.notifications.length === 0) return `${summary} Nothing to show.`;
  return assemble({
    head: [summary],
    entries: r.notifications.map((n) => ({ text: notificationLine(n), item: true })),
    hint: 'lower limit or use unread_only',
  });
}
