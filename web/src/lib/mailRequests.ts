import type { MailRequestAction, MailRequestList, MailRequestStatus } from '../api/types';
import type { MessageKey, Vars } from '../i18n/core';

/** Filter order on the operator page; the first is the default. */
export const MAIL_REQUEST_STATUSES: readonly MailRequestStatus[] = ['pending', 'approved', 'rejected'];

interface RowAction {
  action: MailRequestAction;
  variant: 'primary' | 'secondary' | 'danger';
}

/** What an operator can do with a request in each state. */
const ROW_ACTIONS: Record<MailRequestStatus, readonly RowAction[]> = {
  pending: [
    { action: 'approve', variant: 'primary' },
    { action: 'reject', variant: 'secondary' },
  ],
  approved: [{ action: 'revoke', variant: 'danger' }],
  rejected: [{ action: 'approve', variant: 'secondary' }],
};

export const rowActions = (status: MailRequestStatus): readonly RowAction[] => ROW_ACTIONS[status];

/** Only revoking disconnects a mailbox, so only it asks for confirmation. */
export const needsConfirmation = (action: MailRequestAction): boolean => action === 'revoke';

/** The slots line: "used/limit", or just the used count when there is no limit. */
export function slotsText(slots: MailRequestList['slots']): { key: MessageKey; vars: Vars } {
  if (slots.limit === null) return { key: 'mail.admin.slotsNoLimit', vars: { used: slots.used } };
  return { key: 'mail.admin.slots', vars: { used: slots.used, limit: slots.limit } };
}

/** Parses the `?status=` filter; anything unknown falls back to pending. */
export function parseMailRequestStatus(value: string | null): MailRequestStatus {
  return MAIL_REQUEST_STATUSES.find((s) => s === value) ?? 'pending';
}
