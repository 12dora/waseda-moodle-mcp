/** When may a date written in a task module's own text (or name) count as that module's deadline? */

import type { SnapModule } from './snapshot';

/** Moodle date keys (see snapshot.ts DATE_KEYS) that make a task's deadline known. */
const DEADLINE_KEYS = ['due', 'closes', 'cutoff'];
/** An explicit deadline cue; the date must not be just any date mentioned in passing. */
const STRICT_CUE =
  /締切|締め切り|〆|期限|期日|提出日|提出\s*[:：]|提出\s*(?:\d{4}年|\d{1,2}月|\d{1,2}[/.]\d{1,2})|\bdue\b|deadline|まで|\bby\b|until/i;
/** "第2回の…(提出期限10/15)を出しましたか": a question about, or a reminder of, another task (`?` only at a sentence end). */
const REMINDER = /ました\s*か|ですか|ますか|[?？](?=\s|$|[)）」』\]"'…])|did you|have you/i;
/** Markdown link targets (cut off or not) and bare URLs: their `?id=` is no question and their words no cue. */
const LINK_TARGET = /\]\([^)]*(?:\)|$)|https?:\/\/[\x21-\x7e]+/g;
const ORDINAL = /第\s*(\d+)\s*[回週章課]|\bweek\s*(\d+)|\bsession\s*(\d+)/gi;

export const hasOwnDeadline = (m: SnapModule): boolean => DEADLINE_KEYS.some((k) => m.d?.[k]);

function ordinals(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize('NFKC').matchAll(ORDINAL)) out.add(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * Whether the snippet around a date (from the task's own description) is plausibly the task's own deadline:
 * an explicit deadline cue, not a question about something done, and no lesson number the task's own name does not carry.
 */
export function isOwnDeadlineText(task: SnapModule, evidence: string): boolean {
  const text = evidence.replace(LINK_TARGET, ' ');
  if (!STRICT_CUE.test(text) || REMINDER.test(text)) return false;
  const mine = ordinals(task.n);
  for (const o of ordinals(text)) if (!mine.has(o)) return false;
  return true;
}
