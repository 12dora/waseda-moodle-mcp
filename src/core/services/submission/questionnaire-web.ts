/**
 * mod_questionnaire pages on the web channel, read into the same shapes as the mobile templates
 * (submission/questionnaire.ts):
 * - the index `view.php?id=<cmid>`: the answer link `complete.php?id=` (`&resume=1` = continue the saved draft) and
 *   the link to the user's responses `myreport.php?…` (shown once a response is submitted; the page gives no count);
 * - a form page `complete.php` (and the printable copy `print.php`, the same question markup): the questions
 *   (questionnaire-web-inputs.ts), the hidden fields (sesskey, `a` = instance, `sid` = survey, `rid` = response,
 *   `sec` = page), the buttons by name (`next`, `prev`, `submit`, `resume`) and Moodle's notices; after the last
 *   page the same URL shows the thank-you page;
 * - the user's responses page `myreport.php`: the submitted response, read-only (no inputs, own markup).
 */

import { htmlToMarkdown } from '../../html';
import {
  attr,
  type FormFields,
  findAll,
  findFirst,
  findForm,
  formFields,
  type HtmlElement,
  links,
  mainRegion,
  queryInt,
  text,
} from '../../moodle/web/html';
import type { DueSubmission, QuestionnaireQuestion, QuestionnaireQuestionType } from '../../types';
import { noticesIn, pathOf } from '../activity/web';
import type { QuestionnaireIndex } from './questionnaire';
import { questionHead, type WebQuestion, webQuestion } from './questionnaire-web-inputs';

// ------------------------------------------------------------------ index

const state = (status: DueSubmission['status'], canContinue: boolean, note: string | null = null): DueSubmission => ({
  status,
  canContinue,
  submittedAt: null,
  graded: false,
  note,
});

function stateOf(draft: boolean, responded: boolean, canAnswer: boolean): DueSubmission | null {
  if (draft) return state('draft', true, responded ? 'an earlier response was submitted' : null);
  if (responded) return state('submitted', canAnswer);
  return canAnswer ? state('none', true) : null;
}

/** The plugin's own part of the page (the theme adds panels of its own to region-main). */
const viewRegion = (html: string): string =>
  findFirst(html, { attr: 'class', value: 'mod_questionnaire_viewpage', word: true })?.outer ?? mainRegion(html);

export function parseWebQuestionnaireIndex(html: string, baseUrl: string): QuestionnaireIndex {
  const region = viewRegion(html);
  const hrefs = links(region);
  const answer = hrefs.filter((h) => h.includes('/mod/questionnaire/complete.php'));
  const review = hrefs.find((h) => h.includes('/mod/questionnaire/myreport.php')) ?? null;
  const draft = answer.some((h) => /[?&]resume=1(?!\d)/.test(h));
  const canAnswer = answer.length > 0;
  return {
    state: stateOf(draft, review !== null, canAnswer),
    canAnswer,
    draft,
    draftRid: null,
    submissionIds: [],
    responses: review ? 1 : 0,
    exact: false,
    reviewPath: review ? pathOf(review, baseUrl) : null,
    notice: noticesIn(region, ['message']),
  };
}

// ------------------------------------------------------------------ form pages

type Button = 'next' | 'prev' | 'submit' | 'resume';
const BUTTONS: readonly Button[] = ['next', 'prev', 'submit', 'resume'];

export interface WebFormPage {
  questions: WebQuestion[];
  /** Questions whose inputs this server does not map ("Q3 (question_id 5003)"). */
  unsupported: string[];
  /** The form's action and the values a browser would send (buttons left out); null when the page has no form. */
  action: string | null;
  fields: FormFields;
  /** The button values by name, for the buttons the page shows. */
  buttons: Partial<Record<Button, string>>;
  /** `sec`: the page number Moodle shows. */
  pageNumber: number | null;
  rid: number;
  ids: { questionnaireId: number; surveyId: number } | null;
  /** The printable blank copy of every page (`print.php?…&rid=0…`), when linked. */
  printPath: string | null;
  notice: string | null;
  /**
   * Moodle's thank-you page: the plugin's complete page without the form and without a notice (it shows this only
   * once a response is committed; a refused or closed questionnaire shows its notice there instead).
   */
  thanked: boolean;
}

const COMPLETE_PAGE = { attr: 'class', value: 'mod_questionnaire_completepage', word: true };

/** The outermost of `list` (document order): an element may hold another of the same query. */
function outermost(list: HtmlElement[]): HtmlElement[] {
  const out: HtmlElement[] = [];
  let end = -1;
  for (const el of list) {
    if (el.start < end) continue;
    out.push(el);
    end = el.start + el.outer.length;
  }
  return out;
}

const containers = (html: string) => outermost(findAll(html, { attr: 'class', value: 'qn-container', word: true }));

/**
 * The page of each container: the printable copy heads every page with a `.surveyPage` (one `fieldset.qn-container`
 * per question after it, no wrapper), so the n-th marker before a question puts it on page `first + n - 1`; a form
 * page shows its marker ("page 1 of 3") after the questions, so they all stay on `first`.
 */
function pagesOf(html: string, list: HtmlElement[], first: number): number[] {
  const marks = findAll(html, { attr: 'class', value: 'surveyPage', word: true }).map((m) => m.start);
  return list.map((c) => first + Math.max(0, marks.filter((m) => m < c.start).length - 1));
}

function buttonsOf(formHtml: string): WebFormPage['buttons'] {
  const out: WebFormPage['buttons'] = {};
  for (const el of findAll(formHtml, { attr: 'name' })) {
    if (el.tag !== 'input' && el.tag !== 'button') continue;
    const type = (attr(el.attrs, 'type') || (el.tag === 'button' ? 'submit' : 'text')).toLowerCase();
    const name = BUTTONS.find((b) => b === attr(el.attrs, 'name'));
    if (type === 'submit' && name) out[name] = attr(el.attrs, 'value');
  }
  return out;
}

const intField = (fields: FormFields, name: string): number | null => {
  const n = Number(fields.get(name));
  return Number.isSafeInteger(n) && n >= 0 && fields.has(name) ? n : null;
};

function idsOf(fields: FormFields): WebFormPage['ids'] {
  const questionnaireId = intField(fields, 'a');
  const surveyId = intField(fields, 'sid');
  return questionnaireId && surveyId ? { questionnaireId, surveyId } : null;
}

/** The form's action as a session path (Moodle may print it relative to the plugin's directory). */
function actionPath(action: string, baseUrl: string): string {
  const path = pathOf(action, baseUrl);
  return path.startsWith('/') ? path : `/mod/questionnaire/${path}`;
}

const label = (q: WebQuestion) => `Q${q.question.number ?? q.question.id} (question_id ${q.question.id})`;

/** The questions of a form page (all on page `page`) or of the printable copy (page by page from `page`). */
export function parseWebQuestionnairePage(html: string, baseUrl: string, page = 1): WebFormPage {
  const region = mainRegion(html);
  const form = findForm(region, 'complete.php');
  const scope = form?.inner ?? region;
  const list = containers(scope);
  const pages = pagesOf(scope, list, page);
  const questions = list
    .map((c, i) => webQuestion(c.outer, pages[i] ?? page))
    .filter((q): q is WebQuestion => q !== null);
  const notice = noticesIn(region);
  const fields = form ? formFields(form.inner) : new Map<string, string>();
  const print = links(region).find((h) => h.includes('/mod/questionnaire/print.php') && queryInt(h, 'rid') === null);
  return {
    questions,
    unsupported: questions.filter((q) => q.question.type === 'other').map(label),
    action: form ? actionPath(attr(form.attrs, 'action'), baseUrl) : null,
    fields,
    buttons: form ? buttonsOf(form.inner) : {},
    pageNumber: intField(fields, 'sec'),
    rid: intField(fields, 'rid') ?? 0,
    ids: idsOf(fields),
    printPath: print ? pathOf(print, baseUrl) : null,
    notice,
    thanked: !form && !notice && findFirst(region, COMPLETE_PAGE) !== null,
  };
}

// ------------------------------------------------------------------ a submitted response (myreport.php)

/** The response templates' classes (`questionnaire_response questionnaire_<type>`). */
const RESPONSE_TYPES: Record<string, QuestionnaireQuestionType> = {
  yesno: 'yesno',
  text: 'text',
  essay: 'essay',
  radio: 'radio',
  check: 'checkbox',
  drop: 'dropdown',
  rate: 'rate',
  date: 'date',
  numeric: 'numeric',
  slider: 'slider',
};
const TEXT_ANSWERS: ReadonlySet<QuestionnaireQuestionType> = new Set(['text', 'essay', 'date', 'numeric', 'slider']);
const SELECTED = { attr: 'class', value: 'selected', word: true };

/** The fragment without what only screen readers get (`.accesshide`, "answered") or nobody reads (the ✓ mark). */
function visible(html: string): string {
  const hidden = [
    ...findAll(html, { attr: 'class', value: 'accesshide', word: true }),
    ...findAll(html, { attr: 'aria-hidden', value: 'true' }),
  ].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const h of outermost(hidden)) {
    out += html.slice(at, h.start);
    at = h.start + h.outer.length;
  }
  return out + html.slice(at);
}

const pickedIn = (html: string): string[] => outermost(findAll(html, SELECTED)).map((e) => visible(e.inner));

const FIRST_CELL = /<t[dh](?=[\s>])[^>]*>([\s\S]*?)<\/t[dh]>/i;

/** A rating: "row: picked" for every table row with a pick (the row's first cell names it). */
function rateAnswer(html: string): string | null {
  const rows = html.split(/<tr(?=[\s>])/i).slice(1);
  const out = rows.flatMap((row) => {
    const picked = pickedIn(row).map(text).filter(Boolean).join(', ');
    const label = text(visible(FIRST_CELL.exec(row)?.[1] ?? ''));
    return picked ? [label ? `${label}: ${picked}` : picked] : [];
  });
  return out.length ? out.join('; ') : null;
}

/** The answer in plain words: the picked choices (`.selected`, the others `.unselected`) or the text given. */
function responseAnswer(type: QuestionnaireQuestionType, html: string): string | null {
  if (type === 'rate' && /<tr(?=[\s>])/i.test(html)) return rateAnswer(html);
  const picked = pickedIn(html);
  if (TEXT_ANSWERS.has(type)) return htmlToMarkdown(picked.join('\n'), { maxChars: 4000 }) || null;
  const labels = picked.map(text).filter(Boolean);
  return labels.length ? labels.join('; ') : null;
}

function responseQuestion(c: HtmlElement): QuestionnaireQuestion | null {
  const id = Number(/^qn-(\d+)$/.exec(attr(c.attrs, 'id'))?.[1]);
  const box = findFirst(c.inner, { attr: 'class', value: 'questionnaire_response', word: true });
  if (!box || !Number.isSafeInteger(id) || id <= 0) return null;
  const kind = attr(box.attrs, 'class')
    .split(/\s+/)
    .map((cls) => /^questionnaire_(\w+)$/.exec(cls)?.[1])
    .find((k) => k && k !== 'response');
  const type = (kind && RESPONSE_TYPES[kind]) || 'other';
  return { ...questionHead(c.outer, id, 1), type, answer: responseAnswer(type, box.inner) };
}

/**
 * The submitted response on the user's responses page (`myreport.php`, the latest response): one read-only
 * `fieldset.qn-container` per answered question (`id="qn-<question>"`) holding a `.questionnaire_response` of the
 * question's type. It names no choice ids, so `choices` stays empty and `answer` carries the picked labels; questions
 * left unanswered are not shown, and all count as page 1.
 */
export function parseWebQuestionnaireResponse(html: string): QuestionnaireQuestion[] {
  const out: QuestionnaireQuestion[] = [];
  for (const c of containers(mainRegion(html))) {
    const q = responseQuestion(c);
    if (q && !out.some((x) => x.id === q.id)) out.push(q);
  }
  return out;
}
