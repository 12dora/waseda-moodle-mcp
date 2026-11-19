/** User-facing wording of the mail connection state, and the guard the mail tools and actions share. */

import type { MailApi, ServiceContext } from '../context';
import { Forbidden, MailNeedsReconnect, NotFound } from '../errors';

/** Kept short: the tool layer (toToolError) adds where the user reconnects mail. */
export const MAIL_RECONNECT = 'The Waseda mail connection has expired or was revoked.';

/** The error of a stored connection that no longer works: its lastError when known. */
export const mailReconnect = (lastError: string | null = null): MailNeedsReconnect =>
  new MailNeedsReconnect(lastError ?? MAIL_RECONNECT);

/** The request's mail client; NotFound when the user has no mail connection. */
export function requireMail(ctx: ServiceContext): Promise<MailApi> {
  if (!ctx.mail) throw new NotFound('Waseda mail is not connected. Connect it in the console (Settings → Mail).');
  return ctx.mail();
}

/** Sending needs gmail.send, which the user may have unticked on Google's consent screen. */
export function assertCanSend(api: MailApi): void {
  if (!api.canSend) {
    throw new Forbidden('This mail connection is read-only. Reconnect mail in the console and allow sending.');
  }
}
