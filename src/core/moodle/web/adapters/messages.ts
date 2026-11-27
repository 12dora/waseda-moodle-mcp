/**
 * Messaging on the web channel. Every core_message_* function this codebase uses is ajax-enabled except the unread
 * notification count, which the notification popover's own ajax function answers (a plain number).
 */

import type { WebFunctions } from '../types';

export const messageFunctions: WebFunctions = {
  core_message_get_unread_notification_count: (web, params) =>
    web.ajax<number>('message_popup_get_unread_popup_notification_count', { useridto: params.useridto ?? 0 }),
};
