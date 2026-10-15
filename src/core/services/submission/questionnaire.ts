/**
 * Questionnaire progress. Moodle has no read web service for it, so this reads what the mobile app shows
 * (`tool_mobile_get_content` / `mobile_view_activity`): the template holds translation keys, not prose.
 */

import { isObj } from '../../moodle/wire';
import { isoJst } from '../../time';
import type { DueSubmission, IsoJst } from '../../types';
import type { BatchRequest } from './batch';

const KEY = 'plugin.mod_questionnaire.';
const ANSWER_KEY = `${KEY}answerquestions`;
const JST_OFFSET_MS = 9 * 3_600_000;

export const questionnaireRequest = (cmid: number, moodleUserId: number): BatchRequest => ({
  fn: 'tool_mobile_get_content',
  args: {
    component: 'mod_questionnaire',
    method: 'mobile_view_activity',
    args: [
      { name: 'cmid', value: String(cmid) },
      { name: 'userid', value: String(moodleUserId) },
      { name: 'courseid', value: '0' },
    ],
  },
});

// ------------------------------------------------------------------ date strings

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = MONTHS.join('|');
const ORDINAL = '(?:st|nd|rd|th)?';
const CLOCK = '(?<h>\\d{1,2}):(?<mi>\\d{2})(?:\\s*(?<mer>[ap])\\.?m\\b)?';
/** `2026年 10月 8日(木曜日) 11:11` */
const JA_DATE = /(?<y>\d{4})\s*年\s*(?<mo>\d{1,2})\s*月\s*(?<d>\d{1,2})\s*日\D*?(?<h>\d{1,2}):(?<mi>\d{2})/;
/** `Thursday, 8 October 2026, 11:11 AM` */
const EN_DAY_FIRST = new RegExp(
  `(?<d>\\d{1,2})${ORDINAL}\\s+(?<mon>${MONTH})[a-z]*\\.?,?\\s+(?<y>\\d{4}),?\\s+${CLOCK}`,
  'i',
);
/** `Thursday, October 8, 2026, 11:11 AM` */
const EN_MONTH_FIRST = new RegExp(
  `(?<mon>${MONTH})[a-z]*\\.?\\s+(?<d>\\d{1,2})${ORDINAL},?\\s+(?<y>\\d{4}),?\\s+${CLOCK}`,
  'i',
);

type Groups = Record<string, string | undefined>;

/** 12-hour clock to 24-hour; a time without AM/PM is already 24-hour. */
function hour24(h: number, meridiem: string | undefined): number {
  const mer = meridiem?.toLowerCase();
  if (mer === 'p') return h < 12 ? h + 12 : h;
  return mer === 'a' && h === 12 ? 0 : h;
}

function toIso(g: Groups): IsoJst | null {
  const [y, d, mi] = [Number(g.y), Number(g.d), Number(g.mi)];
  const mo = g.mo ? Number(g.mo) : MONTHS.indexOf((g.mon ?? '').slice(0, 3).toLowerCase()) + 1;
  const h = hour24(Number(g.h), g.mer);
  const valid = y >= 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
  return valid ? isoJst(Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS) : null;
}

/** The time Moodle printed (Japanese or English format, in the user's JST clock) as ISO JST; null if unreadable. */
export function parseSubmitTime(text: string): IsoJst | null {
  const found = JA_DATE.exec(text) ?? EN_DAY_FIRST.exec(text) ?? EN_MONTH_FIRST.exec(text);
  return found?.groups ? toIso(found.groups) : null;
}

// ------------------------------------------------------------------ state

/** After the `submitted` key: its closing `}}` (translate filter), then the time text up to the next tag. */
const SUBMITTED = /plugin\.mod_questionnaire\.submitted(?!\w)(?:[^}<]*\}\})?([^<]*)/;
const SUBMITTED_ALL = /plugin\.mod_questionnaire\.submitted(?!\w)/g;
const RESUME = /plugin\.mod_questionnaire\.resume\w*/;

function templateHtml(content: unknown): string {
  if (!isObj(content) || !Array.isArray(content.templates)) return '';
  return content.templates.map((t) => (isObj(t) && typeof t.html === 'string' ? t.html : '')).join('\n');
}

function state(
  status: DueSubmission['status'],
  canContinue: boolean,
  submittedAt: IsoJst | null = null,
): DueSubmission {
  return { status, canContinue, submittedAt, graded: false, note: null };
}

/**
 * A `resume…` key -> saved draft: the plugin lists every response of the user under `submitted`, the saved one
 * (`complete = 'n'`) included, so the key alone does not mean handed in. Otherwise `submitted` -> answered (with
 * its time); the "answer questions" button alone -> not started; anything else (unknown template) -> null.
 */
export function parseQuestionnaire(content: unknown): DueSubmission | null {
  const html = templateHtml(content);
  if (!html.includes(KEY)) return null;
  const listed = html.match(SUBMITTED_ALL)?.length ?? 0;
  if (RESUME.test(html)) {
    const draft = state('draft', true);
    return listed > 1 ? { ...draft, note: `${listed - 1} earlier response(s) submitted` } : draft;
  }
  const canAnswer = html.includes(ANSWER_KEY);
  const submitted = SUBMITTED.exec(html);
  // answering again is possible only when the "answer questions" button is shown next to the review link
  if (submitted) return state('submitted', canAnswer, parseSubmitTime(submitted[1] ?? ''));
  return canAnswer ? state('none', true) : null;
}
