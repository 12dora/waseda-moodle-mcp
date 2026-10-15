/** Popup notifications (grades, feedback, forum posts, reminders). */

import type { ServiceContext } from '../../context';
import { decodeEntities, htmlToMarkdown } from '../../html';
import { fromTs } from '../../time';
import type { Notification } from '../../types';
import { clampInt } from '../shared';

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

export interface NotificationPage {
  notifications: Notification[];
  unreadCount: number;
  /** `offset` for the next (older) page; null when the feed has nothing more. */
  nextOffset: number | null;
}

const NOTIFICATION_MAX_CHARS = 600;
const MAX_FEED_WINDOW = 100;

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

/** The first `limit` wanted notifications and how many raw feed entries that consumed (the next offset). */
function takePage(raw: RawNotification[], limit: number, unreadOnly: boolean): { items: Notification[]; used: number } {
  const items: Notification[] = [];
  let used = 0;
  for (const r of raw) {
    if (items.length >= limit) break;
    used++;
    const n = mapNotification(r);
    if (!unreadOnly || !n.read) items.push(n);
  }
  return { items, used };
}

export async function listNotifications(
  ctx: ServiceContext,
  opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<NotificationPage> {
  const limit = clampInt(opts.limit, 20, 1, 100);
  const offset = clampInt(opts.offset, 0, 0, 10_000);
  const api = await ctx.moodle();
  // the popup feed has no unread filter, so read a wider window when only unread ones are wanted
  const span = opts.unreadOnly ? Math.min(MAX_FEED_WINDOW, limit * 3) : limit;
  const res = await api.call<{ notifications?: RawNotification[] | null; unreadcount?: number | null }>(
    'message_popup_get_popup_notifications',
    { useridto: ctx.user.moodleUserId, newestfirst: true, limit: span, offset },
  );
  const raw = res?.notifications ?? [];
  const { items, used } = takePage(raw, limit, opts.unreadOnly === true);
  const more = used < raw.length || raw.length >= span;
  return {
    notifications: items,
    unreadCount: res?.unreadcount ?? raw.filter((n) => n.read !== true).length,
    nextOffset: more && used > 0 ? offset + used : null,
  };
}
