import { ApiError } from '../api/client';
import type { MessageKey, Translate } from '../i18n/core';

const CODE_MESSAGES: Readonly<Record<string, MessageKey>> = {
  network: 'common.networkError',
  forbidden: 'error.forbidden',
  not_found: 'error.not_found',
  invalid_input: 'error.invalid_input',
  needs_reconnect: 'error.needs_reconnect',
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
