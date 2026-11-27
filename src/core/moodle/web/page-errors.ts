/**
 * Moodle error pages (print_error / moodle_exception rendered as HTML): `<div data-rel="fatalerror" class="box …
 * errorbox …"><p class="errormessage">…</p><p class="errorcode"><a href="…/error/moodle/nopermissions">`.
 * The docs link carries Moodle's error code (machine value); the text is the fallback (ja and en).
 */

import { MoodleError } from '../../errors';
import { findFirst, text } from './html';

const MARKERS = ['data-rel="fatalerror"', 'class="box errorbox', ' errorbox ', 'class="errormessage"'];

/** Moodle error codes (the docs link) -> the codes this codebase uses. */
const CODES: Readonly<Record<string, string>> = {
  nopermissions: 'nopermissions',
  accessdenied: 'nopermissions',
  invalidrecord: 'invalidrecord',
  invalidrecordunknown: 'invalidrecord',
  invalidcoursemodule: 'invalidrecord',
  invalidcourseid: 'invalidrecord',
  invalidid: 'invalidrecord',
  requireloginerror: 'requireloginerror',
  notenrolled: 'requireloginerror',
};

/** Text patterns per code, for error pages without a docs link (first match wins). */
const TEXTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/パーミッションがありません|do not currently have permissions|Sorry, but you do not/i, 'nopermissions'],
  [/データレコードが見つかりません|Can't find data record|Invalid course module ID/i, 'invalidrecord'],
  [/このコースに登録されていません|You are not enrolled|You cannot/i, 'requireloginerror'],
];

const MAX_MESSAGE = 200;

function errorCode(html: string, message: string): string {
  const linked = /\/error\/[a-z0-9_]+\/([a-z0-9_]+)"/i.exec(html)?.[1]?.toLowerCase() ?? '';
  const mapped = CODES[linked];
  if (mapped) return mapped;
  return TEXTS.find(([re]) => re.test(message))?.[1] ?? 'moodle_error';
}

function clip(s: string): string {
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s;
}

/** The MoodleError a Moodle error page stands for, or null for an ordinary page. */
export function pageError(html: string): MoodleError | null {
  if (!MARKERS.some((m) => html.includes(m))) return null;
  const box =
    findFirst(html, { attr: 'data-rel', value: 'fatalerror' }) ??
    findFirst(html, { attr: 'class', value: 'errorbox', word: true });
  const scope = box?.outer ?? html;
  const msgEl = findFirst(scope, { attr: 'class', value: 'errormessage', word: true });
  if (!box && !msgEl) return null;
  const message = clip(text(msgEl?.inner ?? box?.inner ?? '')) || 'Moodle showed an error page.';
  return new MoodleError(message, errorCode(scope, message));
}
