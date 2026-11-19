import type { MailConnection, MailInfo } from '../api/types';
import type { MessageKey } from '../i18n/core';

/**
 * What the mail UI shows: the live or a broken connection, or one of the states without a connection
 * (connect when approved, apply / pending / rejected for the operator's approval, full when no slot is left).
 */
export type MailView = 'active' | 'invalid' | 'connect' | 'apply' | 'pending' | 'rejected' | 'full';

/** The views without a connection. */
export type SetupView = Exclude<MailView, 'active' | 'invalid'>;

/** A user who holds a slot, or while slots remain (or are unlimited), may connect or apply. */
function mayConnectMail(info: MailInfo): boolean {
  return info.hasSlot || info.slotsLeft === null || info.slotsLeft > 0;
}

const UNAPPROVED_VIEW = { none: 'apply', pending: 'pending', rejected: 'rejected', approved: 'connect' } as const;

export function mailView(info: MailInfo): MailView {
  if (info.connection) return info.connection.status === 'active' ? 'active' : 'invalid';
  return mayConnectMail(info) ? UNAPPROVED_VIEW[info.access] : 'full';
}

export function isSetupView(view: MailView): view is SetupView {
  return view !== 'active' && view !== 'invalid';
}

/** The explanation shown with the state's action on the Settings page. */
const NOTE_KEY: Record<SetupView, MessageKey> = {
  connect: 'mail.desc',
  apply: 'mail.desc',
  pending: 'mail.pending',
  rejected: 'mail.rejected',
  full: 'mail.full',
};

export const mailNoteKey = (view: SetupView): MessageKey => NOTE_KEY[view];

/** The one-line status on the Overview card (`{address}` and `{access}` fill the connected text). */
const STATUS_KEY: Record<MailView, MessageKey> = {
  active: 'mail.status.connected',
  invalid: 'mail.status.ended',
  connect: 'mail.status.none',
  apply: 'mail.status.none',
  pending: 'mail.status.pending',
  rejected: 'mail.rejected',
  full: 'mail.full',
};

export const mailStatusKey = (view: MailView): MessageKey => STATUS_KEY[view];

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
  unapproved: { key: 'mail.result.unapproved', tone: 'error' },
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
