/** The requests of one tick's ajax calls (/lib/ajax/service.php batches) and how their answers are read. */

import { MoodleError } from '../../errors';
import { isObj } from '../wire';

const MAX_BATCH = 25;
/** Per-entry codes that concern the whole request (service.php checks login and sesskey for each call). */
const ENTRY_BATCH_CODES = new Set(['servicerequireslogin', 'invalidsesskey']);

export interface Pending {
  fn: string;
  args: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** Splits one tick's calls into requests: at most 25 per POST, every core_get_fragment alone. */
export function batches(pending: Pending[]): Pending[][] {
  const out: Pending[][] = [];
  let current: Pending[] = [];
  for (const p of pending) {
    if (p.fn === 'core_get_fragment') {
      out.push([p]);
      continue;
    }
    if (current.length >= MAX_BATCH) current = [];
    if (current.length === 0) out.push(current);
    current.push(p);
  }
  return out;
}

function entryCode(entry: unknown): string {
  if (!isObj(entry) || entry.error !== true || !isObj(entry.exception)) return '';
  return typeof entry.exception.errorcode === 'string' ? entry.exception.errorcode : '';
}

/**
 * The code of a failure of the whole request: an error object, or an entry refused for login/sesskey (any entry: one
 * that needs no login, such as core_get_string, answers even when the session is over).
 */
export function batchFailure(parsed: unknown): { code: string; message: string } | null {
  if (isObj(parsed)) {
    const code = typeof parsed.errorcode === 'string' ? parsed.errorcode : 'moodle_error';
    const message = typeof parsed.error === 'string' ? parsed.error : String(parsed.message ?? '');
    return { code, message };
  }
  if (!Array.isArray(parsed)) return { code: 'unavailable', message: '' };
  const code = parsed.map(entryCode).find((c) => ENTRY_BATCH_CODES.has(c));
  return code ? { code, message: '' } : null;
}

export function settle(p: Pending, entry: unknown): void {
  if (!isObj(entry)) {
    p.reject(new MoodleError('Moodle returned an incomplete answer.', 'moodle_error'));
    return;
  }
  if (entry.error !== true) {
    p.resolve(entry.data);
    return;
  }
  const ex = isObj(entry.exception) ? entry.exception : {};
  const message = typeof ex.message === 'string' && ex.message ? ex.message : 'Moodle returned an error.';
  p.reject(new MoodleError(message, entryCode(entry) || 'moodle_error'));
}
