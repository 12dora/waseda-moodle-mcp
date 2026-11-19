import type { MailConnection, MailInfo } from '../api/types';
import type { MessageKey } from '../i18n/core';

/** What the Mail tab shows: the live connection, a broken one, the connect prompt, or the "slots full" notice. */
export type MailView = 'active' | 'invalid' | 'connect' | 'full';

/** A user who holds a slot, or while slots remain (or are unlimited), may connect. */
function mayConnectMail(info: MailInfo): boolean {
  return info.hasSlot || info.slotsLeft === null || info.slotsLeft > 0;
}

export function mailView(info: MailInfo): MailView {
  if (info.connection) return info.connection.status === 'active' ? 'active' : 'invalid';
  return mayConnectMail(info) ? 'connect' : 'full';
}

/** Reconnecting is offered for a broken connection, and for a read-only one (sending needs the send permission). */
export function canReconnectMail(connection: MailConnection): boolean {
  return connection.status === 'invalid' || !connection.canSend;
}

/** Epoch milliseconds → the ISO string the display formatters take; null stays null. */
export function isoOfMs(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Outcomes Google's redirect reports in `/settings/mail?mail=<result>`. */
const RESULT_TEXT = {
  connected: { key: 'mail.result.connected', tone: 'success' },
  denied: { key: 'mail.result.denied', tone: 'info' },
  expired: { key: 'mail.result.expired', tone: 'error' },
  domain: { key: 'mail.result.domain', tone: 'error' },
  scope: { key: 'mail.result.scope', tone: 'error' },
  full: { key: 'mail.full', tone: 'error' },
  failed: { key: 'mail.result.failed', tone: 'error' },
  session: { key: 'mail.result.failed', tone: 'error' },
} as const satisfies Record<string, { key: MessageKey; tone: 'success' | 'info' | 'error' }>;

type MailResult = keyof typeof RESULT_TEXT;

interface MailResultNotice {
  key: MessageKey;
  tone: 'success' | 'info' | 'error';
}

/** The notice for a `?mail=` value; unknown or missing values give null. */
export function mailResultNotice(value: string | null): MailResultNotice | null {
  if (value === null || !Object.hasOwn(RESULT_TEXT, value)) return null;
  return RESULT_TEXT[value as MailResult];
}

/** The same URL without the `mail` query parameter (path, remaining query and hash kept). */
export function withoutMailParam(href: string): string {
  const url = new URL(href, 'https://console.invalid');
  url.searchParams.delete('mail');
  return `${url.pathname}${url.search}${url.hash}`;
}
