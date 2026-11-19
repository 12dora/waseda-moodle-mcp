import { ApiError } from '../api/client';
import type { MessageKey, Translate } from '../i18n/core';

const CODE_MESSAGES: Readonly<Record<string, MessageKey>> = {
  network: 'common.networkError',
  forbidden: 'error.forbidden',
  not_found: 'error.not_found',
  invalid_input: 'error.invalid_input',
  needs_reconnect: 'error.needs_reconnect',
  mail_needs_reconnect: 'error.mail_needs_reconnect',
  rate_limited: 'error.rate_limited',
  moodle_unavailable: 'error.moodle_unavailable',
  budget_exceeded: 'error.budget_exceeded',
  service_paused: 'paused.desc',
  edge_challenge: 'paused.unavailable',
};

/** User-facing text for any thrown value: known codes are localized, otherwise the (safe) server message. */
export function errorText(e: unknown, t: Translate): string {
  if (e instanceof ApiError) {
    const key = CODE_MESSAGES[e.code];
    if (key) return t(key);
    if (e.message && !/^HTTP \d+$/.test(e.message)) return e.message;
    return t('common.requestFailed', { status: e.status });
  }
  if (e instanceof Error && e.message) return e.message;
  return t('common.requestFailed', { status: '?' });
}

/** Known approve / cancel / mail decision refusals (exact server messages) → localized text. */
const REFUSALS: Readonly<Record<string, MessageKey>> = {
  'Another action for the same target already ran. Prepare it again if you still need it.':
    'actions.refusal.superseded',
  'This action has expired. Prepare it again.': 'actions.refusal.expired',
  'This action was cancelled.': 'actions.refusal.cancelled',
  'This action is already running.': 'actions.refusal.running',
  'Another action for the same target is running.': 'actions.refusal.running',
  'The request changed. Reload and try again.': 'mail.admin.refusal.changed',
  'The request is not pending.': 'mail.admin.refusal.changed',
  'Mail access is not approved.': 'mail.rejected',
  'Operators are always approved.': 'mail.admin.refusal.operator',
};

/** Like `errorText`, but an `invalid_input` answer keeps its meaning: known refusals are localized, others show the server text. */
export function serverMessageText(e: unknown, t: Translate): string {
  if (e instanceof ApiError && e.code === 'invalid_input' && e.message && !/^HTTP \d+$/.test(e.message)) {
    const key = REFUSALS[e.message];
    return key ? t(key) : e.message;
  }
  return errorText(e, t);
}
