/**
 * Questionnaire templates. Moodle has no read web service for questionnaires, so this reads what the mobile app shows
 * (`tool_mobile_get_content` / `mobile_view_activity`): the index page (progress, notices, review links) and the
 * question pages (`respond`, `review`). The templates hold translation keys and Ionic widgets, not prose; everything
 * here is a linear regex / string scan.
 */

import { decodeEntities, htmlToMarkdown, htmlToText, tagAttr } from '../../html';
import { isObj } from '../../moodle/wire';
import { isoJst } from '../../time';
import type {
  DueSubmission,
  IsoJst,
  QuestionnaireChoice,
  QuestionnaireQuestion,
  QuestionnaireQuestionType,
} from '../../types';
import type { BatchRequest } from './batch';

const KEY = 'plugin.mod_questionnaire.';
const ANSWER_KEY = `${KEY}answerquestions`;
const JST_OFFSET_MS = 9 * 3_600_000;

/** Only the read-only actions: `submit` / `nextpage` / `previouspage` save answers. */
type QuestionnaireView =
  | { action: 'respond'; pagenum: number; rid?: number }
  | { action: 'review'; submissionid: number };

/** The index page by default; `view` reads a question page or a submitted response. */
export const questionnaireRequest = (cmid: number, moodleUserId: number, view?: QuestionnaireView): BatchRequest => ({
  fn: 'tool_mobile_get_content',
  args: {
    component: 'mod_questionnaire',
    method: 'mobile_view_activity',
    args: [
      { name: 'cmid', value: String(cmid) },
      { name: 'userid', value: String(moodleUserId) },
      { name: 'courseid', value: '0' },
      ...Object.entries(view ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => ({ name, value: String(value) })),
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

// ------------------------------------------------------------------ index page

/** After the `submitted` key: its closing `}}` (translate filter), then the time text up to the next tag. */
const SUBMITTED = /plugin\.mod_questionnaire\.submitted(?!\w)(?:[^}<]*\}\})?([^<]*)/;
const SUBMITTED_ALL = /plugin\.mod_questionnaire\.submitted(?!\w)/g;
const RESUME = /plugin\.mod_questionnaire\.resume\w*/;
const REVIEW_ID = /\bsubmissionid:\s*(\d+)/g;
const CARD = /<ion-card-content>([\s\S]*?)<\/ion-card-content>/g;

function templateHtml(content: unknown): string {
  if (!isObj(content) || !Array.isArray(content.templates)) return '';
  return content.templates.map((t) => (isObj(t) && typeof t.html === 'string' ? t.html : '')).join('\n');
}

/** `name: 123` inside the `[args]` of a template button. */
function argNumber(html: string, name: string): number | null {
  const m = new RegExp(`\\b${name}:\\s*(\\d+)`).exec(html);
  return m ? Number(m[1]) : null;
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
function stateOf(html: string): DueSubmission | null {
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

export const parseQuestionnaire = (content: unknown): DueSubmission | null => stateOf(templateHtml(content));

/** Moodle's notices (closed, not open yet, a refused save): the cards that hold plain text, not widgets. */
function noticeText(html: string): string | null {
  const out: string[] = [];
  for (const m of html.matchAll(CARD)) {
    const inner = m[1] ?? '';
    if (inner.includes('<ion-') || inner.includes('{{')) continue;
    const text = htmlToText(inner);
    if (text) out.push(text);
  }
  return out.length ? out.join(' ') : null;
}

export interface QuestionnaireIndex {
  state: DueSubmission | null;
  /** The "answer questions" or "resume" button is shown. */
  canAnswer: boolean;
  draft: boolean;
  /** Response id of the saved draft when the resume button names it. */
  draftRid: number | null;
  /** Review links of the user's responses (the saved draft included), as listed. */
  submissionIds: number[];
  notice: string | null;
}

export function parseQuestionnaireIndex(content: unknown): QuestionnaireIndex {
  const html = templateHtml(content);
  const draft = RESUME.test(html);
  return {
    state: stateOf(html),
    canAnswer: draft || html.includes(ANSWER_KEY),
    draft,
    draftRid: draft ? argNumber(html, 'rid') : null,
    submissionIds: [...html.matchAll(REVIEW_ID)].map((m) => Number(m[1])),
    notice: noticeText(html),
  };
}

// ------------------------------------------------------------------ question pages

const TYPES: Record<number, QuestionnaireQuestionType> = {
  1: 'yesno',
  2: 'text',
  3: 'essay',
  4: 'radio',
  5: 'checkbox',
  6: 'dropdown',
  8: 'rate',
  9: 'date',
  10: 'numeric',
  11: 'slider',
};

/**
 * A question heading: an item with the number badge (when numbered), the prompt and the "required" badge, and
 * nothing else. Choice items carry a widget after the label; review answers carry `CONTENT_OTHERDATA` (skipped).
 */
const HEADER =
  /<ion-item(?=[\s>])[^>]*>\s*(?:<ion-badge[^>]*slot="start"[^>]*>([^<]*)<\/ion-badge>\s*)?<ion-label>\s*<core-format-text\s+text="([^"]*)"[^>]*>\s*<\/core-format-text>\s*<\/ion-label>\s*(<ion-badge[^>]*>\s*\{\{\s*'plugin\.mod_questionnaire\.required'[^<]*<\/ion-badge>\s*)?<\/ion-item>/g;
/** `response_{type}_{question}[_{choice}]`: the field names the plugin reads back. */
const FIELD = /CONTENT_OTHERDATA\.response_(\d+)_(\d+)(?:_(\w+))?/;
const LABEL = /<core-format-text\b[^>]*?\btext="([^"]*)"/;
const RADIO = /<ion-radio(?=[\s>])([^>]*)>/;
const RADIO_ALL = new RegExp(RADIO.source, 'g');
const CHECKBOX = /<ion-checkbox(?=[\s>])([^>]*)>/;
const OPTION = /<ion-select-option(?=[\s>])([^>]*)>([^<]*)<\/ion-select-option>/g;
const OTHER_FIELD = /<ion-input(?=[\s>])[^>]*CONTENT_OTHERDATA\.response_\d+_\d+_o(\d+)/g;
const RATE_ROW =
  /<core-format-text\s+text="([^"]*)"[^>]*>\s*<\/core-format-text>\s*<\/ion-label>\s*<ion-badge[^>]*>\s*\{\{\s*CONTENT_OTHERDATA\.response_8_\d+_(\w+)/g;
const RATE_GROUP = /<ion-radio-group[^>]*CONTENT_OTHERDATA\.response_8_\d+_\w+[^>]*>([\s\S]*?)<\/ion-radio-group>/;
const RATE_HEAD = /<ion-col>\s*<ion-label>([^<]*)<\/ion-label>/g;
const RANGE = /<ion-range(?=[\s>])([^>]*)>/;
const NEXT_PAGE = /\baction:\s*'nextpage'/;
const SUBMIT_IDS = /\bquestionnaireid:\s*(\d+),\s*surveyid:\s*(\d+)/;

const label = (raw: string): string => htmlToText(decodeEntities(raw));

/** The prompt without the "3. " Moodle prefixes when it numbers the questions. */
function prompt(raw: string, number: string | null): string {
  let html = decodeEntities(raw);
  if (number) html = html.replace(/^\s*\d+\.\s*/, '');
  return htmlToMarkdown(html, { maxChars: 2000 });
}

/** One chunk per `<ion-item>`: each choice of a radio / checkbox list sits in its own item. */
const items = (body: string): string[] => body.split(/<ion-item(?=[\s>])/).slice(1);

function choiceOf(chunk: string, widget: RegExp): QuestionnaireChoice | null {
  const attrs = widget.exec(chunk)?.[1];
  if (attrs === undefined) return null;
  const id = tagAttr(attrs, 'value') || tagAttr(attrs, '[value]');
  return id === '' ? null : { id, label: label(LABEL.exec(chunk)?.[1] ?? ''), otherText: false };
}

function listChoices(type: QuestionnaireQuestionType, body: string): QuestionnaireChoice[] {
  if (type === 'dropdown') {
    return [...body.matchAll(OPTION)].map((m) => ({
      id: tagAttr(m[1] ?? '', 'value'),
      label: label(m[2] ?? ''),
      otherText: false,
    }));
  }
  const widget = type === 'checkbox' ? CHECKBOX : RADIO;
  const choices = items(body)
    .map((chunk) => choiceOf(chunk, widget))
    .filter((c): c is QuestionnaireChoice => c !== null);
  const others = new Set([...body.matchAll(OTHER_FIELD)].map((m) => m[1]));
  return choices.map((c) => (others.has(c.id) ? { ...c, otherText: true } : c));
}

/** Rows of a rating question, and the values of its first row with the column headings as labels. */
function rateParts(body: string): Pick<QuestionnaireQuestion, 'choices' | 'scale'> {
  const choices = [...body.matchAll(RATE_ROW)].map((m) => ({
    id: m[2] ?? '',
    label: label(m[1] ?? ''),
    otherText: false,
  }));
  const group = RATE_GROUP.exec(body);
  const heads = [...body.slice(0, group?.index ?? 0).matchAll(RATE_HEAD)].map((m) => label(m[1] ?? ''));
  const scale: QuestionnaireQuestion['scale'] = [];
  for (const m of (group?.[1] ?? '').matchAll(RADIO_ALL)) {
    const value = tagAttr(m[1] ?? '', 'value');
    if (value) scale.push({ value, label: heads[scale.length] || value });
  }
  return { choices, scale };
}

function rangeOf(body: string): QuestionnaireQuestion['range'] {
  const attrs = RANGE.exec(body)?.[1];
  if (attrs === undefined) return null;
  const attr = (name: string): number => Number(tagAttr(attrs, name));
  const [min, max] = [attr('min'), attr('max')];
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max, step: attr('step') || 1 } : null;
}

// ------------------------------------------------------------------ answers (review / saved draft)

type Values = ReadonlyMap<string, string>;

/** `otherdata`: the filled `response_*` fields, as `{name, value}` pairs (or a plain map). */
function otherValues(content: unknown): Values {
  const data = isObj(content) ? content.otherdata : null;
  let pairs: unknown[][] = [];
  if (Array.isArray(data)) pairs = data.map((e) => (isObj(e) ? [e.name, e.value] : []));
  else if (isObj(data)) pairs = Object.entries(data);
  const out = new Map<string, string>();
  for (const [name, value] of pairs) {
    if (typeof name !== 'string') continue;
    if (typeof value === 'string' || typeof value === 'number') out.set(name, String(value));
  }
  return out;
}

const ticked = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v !== 'false';

/** A saved text answer as read back: Markdown, bounded. */
const readText = (value: string): string | null => htmlToMarkdown(value, { maxChars: 4000 }) || null;

/** The answer in plain words: choice labels (with the "other" text), rating rows, or the text through `text`. */
function answerOf(q: QuestionnaireQuestion, key: string, values: Values, text = readText): string | null {
  const withOther = (c: QuestionnaireChoice): string => {
    const text = c.otherText ? values.get(`${key}_o${c.id}`) : undefined;
    return text ? `${c.label.replace(/[:：]\s*$/, '')}: ${text}` : c.label;
  };
  const joined = (list: string[]): string | null => (list.length ? list.join('; ') : null);
  const own = values.get(key);
  switch (q.type) {
    case 'yesno':
    case 'radio':
    case 'dropdown': {
      const c = q.choices.find((x) => x.id === own);
      return c ? withOther(c) : null;
    }
    case 'checkbox':
      return joined(q.choices.filter((c) => ticked(values.get(`${key}_${c.id}`))).map(withOther));
    case 'rate':
      return joined(
        q.choices.flatMap((c) => {
          const v = values.get(`${key}_${c.id}`);
          return v ? [`${c.label}: ${q.scale.find((s) => s.value === v)?.label ?? v}`] : [];
        }),
      );
    default:
      return own ? text(own) : null;
  }
}

/** `response_{type}_{question}`: the field (prefix) the plugin reads for a question; null for unknown types. */
export function fieldKey(q: QuestionnaireQuestion): string | null {
  const typeId = Object.keys(TYPES).find((k) => TYPES[Number(k)] === q.type);
  return typeId ? `response_${typeId}_${q.id}` : null;
}

/** The answer that a set of fields gives a question, in plain words, with any text in full exactly as it is sent. */
export function answerText(q: QuestionnaireQuestion, fields: Readonly<Record<string, string>>): string | null {
  const key = fieldKey(q);
  return key ? answerOf(q, key, new Map(Object.entries(fields)), (value) => value) : null;
}

// ------------------------------------------------------------------ page

const CHOICE_TYPES: ReadonlySet<QuestionnaireQuestionType> = new Set(['yesno', 'radio', 'checkbox', 'dropdown']);

function question(head: RegExpMatchArray, body: string, page: number, values: Values): QuestionnaireQuestion | null {
  const field = FIELD.exec(body);
  if (!field) return null; // no widget the app can show
  const type = TYPES[Number(field[1])] ?? 'other';
  const number = head[1]?.trim() || null;
  const parts =
    type === 'rate' ? rateParts(body) : { choices: CHOICE_TYPES.has(type) ? listChoices(type, body) : [], scale: [] };
  const q: QuestionnaireQuestion = {
    id: Number(field[2]),
    page,
    number,
    type,
    required: Boolean(head[3]),
    prompt: prompt(head[2] ?? '', number),
    ...parts,
    range: type === 'slider' ? rangeOf(body) : null,
    answer: null,
  };
  return { ...q, answer: answerOf(q, `response_${field[1]}_${field[2]}`, values) };
}

interface QuestionnairePage {
  questions: QuestionnaireQuestion[];
  hasNextPage: boolean;
  /** Moodle's page number and response id, as its page buttons carry them (`rid` 0 = no saved response yet). */
  pageNumber: number | null;
  rid: number | null;
  /** Instance and survey ids from the submit button (last page only). */
  submitIds: { questionnaireId: number; surveyId: number } | null;
  notice: string | null;
}

/**
 * The questions of a `respond` page (or of every page, for `review`), with the answers `otherdata` carries:
 * the saved draft on a respond page, the submitted response on a review page. Each question runs from its heading
 * to the next one.
 */
export function parseQuestionnairePage(content: unknown, page: number): QuestionnairePage {
  const html = templateHtml(content);
  const values = otherValues(content);
  const heads = [...html.matchAll(HEADER)].filter((m) => !(m[2] ?? '').includes('CONTENT_OTHERDATA'));
  const questions: QuestionnaireQuestion[] = [];
  heads.forEach((head, i) => {
    const start = (head.index ?? 0) + head[0].length;
    const q = question(head, html.slice(start, heads[i + 1]?.index ?? html.length), page, values);
    if (q) questions.push(q);
  });
  const ids = SUBMIT_IDS.exec(html);
  return {
    questions,
    hasNextPage: NEXT_PAGE.test(html),
    pageNumber: argNumber(html, 'pagenum'),
    rid: argNumber(html, 'rid'),
    submitIds: ids ? { questionnaireId: Number(ids[1]), surveyId: Number(ids[2]) } : null,
    notice: noticeText(html),
  };
}
