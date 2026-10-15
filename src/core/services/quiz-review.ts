/**
 * Quiz review (read only): the finished attempts of a quiz and, for one of them, every question with the user's
 * answer, marks, right answer and feedback — whatever the quiz's review options let Moodle show.
 * Never starts or continues an attempt.
 */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, MoodleError, NotFound } from '../errors';
import { htmlToMarkdown } from '../html';
import type { QuizAttempt } from '../types';
import { getActivity } from './activity';
import { fetchUserAttempts } from './activity/quiz';

const MAX_QUESTIONS = 60;
/** Moodle calls spent on the pages of a quiz longer than MAX_QUESTIONS (the request has a 50-subrequest budget). */
const MAX_PAGE_CALLS = 12;
const MAX_HTML = 60_000;
/** Per-question caps (characters of markdown); the full text of a long question is never needed to study. */
const CAP = { text: 1500, answer: 1200, rightAnswer: 500, feedback: 800 };

export interface QuizReviewQuestion {
  number: string; // as printed by Moodle ("1", "2", "i" for info items)
  type: string; // multichoice, truefalse, shortanswer, match, essay, …
  state: string; // gradedright, gradedwrong, gradedpartial, needsgrading, complete, gaveup, …
  status: string; // Moodle's own (localised) label of the state
  mark: number | null; // null when the review options hide marks
  maxMark: number | null;
  text: string; // the question, markdown
  answer: string; // the user's response; choices are listed with [x] / [ ], inputs shown as ⟦value⟧
  rightAnswer: string | null;
  feedback: string | null;
}

export interface QuizReview {
  cmid: number;
  quizId: number;
  courseId: number;
  courseName: string;
  name: string;
  url: string;
  attempts: QuizAttempt[]; // finished attempts, oldest first
  reviewedAttempt: number | null; // attempt number the questions belong to
  questions: QuizReviewQuestion[];
  note: string | null;
}

interface RawReviewQuestion {
  type?: string | null;
  questionnumber?: string | null;
  number?: number | null;
  html?: string | null;
  state?: string | null;
  status?: string | null;
  mark?: string | number | null;
  maxmark?: string | number | null;
}

// ------------------------------------------------------------------ html helpers (no DOM: linear scans)

type DivClass = 'formulation' | 'qtext' | 'rightanswer' | 'specificfeedback' | 'generalfeedback' | 'comment';

const divOpener = (cls: DivClass): RegExp =>
  new RegExp(`<div\\b[^>]*\\sclass="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>`, 'i');
const DIV_OPEN: Record<DivClass, RegExp> = {
  formulation: divOpener('formulation'),
  qtext: divOpener('qtext'),
  rightanswer: divOpener('rightanswer'),
  specificfeedback: divOpener('specificfeedback'),
  generalfeedback: divOpener('generalfeedback'),
  comment: divOpener('comment'),
};
const DIV_TAG = /<(\/?)div\b[^>]*>/gi;

interface DivRange {
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
}

/** The first `<div class="… cls …">` with its matching close tag (an unclosed div runs to the end). */
function findDiv(html: string, cls: DivClass): DivRange | null {
  const open = DIV_OPEN[cls].exec(html);
  if (!open) return null;
  const innerStart = open.index + open[0].length;
  DIV_TAG.lastIndex = innerStart;
  let depth = 1;
  for (let m = DIV_TAG.exec(html); m; m = DIV_TAG.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { start: open.index, innerStart, innerEnd: m.index, end: m.index + m[0].length };
  }
  return { start: open.index, innerStart, innerEnd: html.length, end: html.length };
}

const HIDDEN_TEXT = /<(span|label|legend|h4)\b[^>]*\b(?:accesshide|visually-hidden|sr-only)\b[^>]*>[\s\S]*?<\/\1>/gi;
const INPUT = /<input\b[^>]*>/gi;
const SELECT = /<select\b[^>]*>([\s\S]*?)<\/select>/gi;
const OPTION = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
const TEXTAREA = /<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi;
const ICON = /<i\b[^>]*\bfa-(?:circle-)?(check|xmark|remove|times)\b[^>]*>\s*<\/i>/gi;
/** A bare "[x]" / "a." marker left alone on its line by the block tags around option labels. */
const LONE_MARKER = /^(\[[ x]\](?: [A-Za-z0-9]{1,3}\.)?|[A-Za-z0-9]{1,3}\.)[ \t]*\n+(?=[^\s[])/gm;
const BLANK_BEFORE_OPTION = /\n{2,}(?=\[[ x]\] )/g;
const BREAK_BEFORE_ICON = /\n+(?=[✓✗])/g;

const attrValue = (tag: string, name: string): string => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1] ?? '';
const shown = (value: string): string => (value.trim() ? `⟦${value.trim()}⟧` : '⟦ ⟧');

function inputMark(tag: string): string {
  const type = (attrValue(tag, 'type') || 'text').toLowerCase();
  if (type === 'radio' || type === 'checkbox') return /\schecked\b/i.test(tag) ? '[x] ' : '[ ] ';
  if (type === 'text' || type === 'number') return shown(attrValue(tag, 'value'));
  return '';
}

function selectedOption(options: string): string {
  OPTION.lastIndex = 0;
  for (let m = OPTION.exec(options); m; m = OPTION.exec(options)) {
    const attrs = m[1] ?? '';
    const value = attrValue(attrs, 'value');
    if (/\sselected\b/i.test(attrs) && value !== '' && value !== '0') return shown(m[2] ?? '');
  }
  return shown('');
}

/** Replaces form widgets by plain text marks, drops screen-reader-only text. */
function widgetsToText(html: string): string {
  return html
    .replace(HIDDEN_TEXT, '')
    .replace(INPUT, inputMark)
    .replace(SELECT, (_all, options: string) => selectedOption(options))
    .replace(TEXTAREA, '<div>$1</div>')
    .replace(ICON, (_all, kind: string) => (kind === 'check' ? ' ✓' : ' ✗'));
}

function answerMarkdown(html: string): string {
  const md = htmlToMarkdown(widgetsToText(html), { maxChars: CAP.answer });
  // two passes: "[x]\na.\n\ntext" joins to "[x] a.\n\ntext" and then to "[x] a. text"
  return md
    .replace(LONE_MARKER, '$1 ')
    .replace(LONE_MARKER, '$1 ')
    .replace(BREAK_BEFORE_ICON, ' ')
    .replace(BLANK_BEFORE_OPTION, '\n');
}

const flatten = (s: string): string => s.replace(/\s*\n+\s*/g, ' ').trim();

function divMarkdown(html: string, cls: DivClass, maxChars: number): string {
  const r = findDiv(html, cls);
  return r ? htmlToMarkdown(html.slice(r.innerStart, r.innerEnd), { maxChars }) : '';
}

const FEEDBACK_CLASSES: DivClass[] = ['specificfeedback', 'generalfeedback', 'comment'];

function feedbackMarkdown(html: string): string | null {
  const parts = FEEDBACK_CLASSES.map((c) => divMarkdown(html, c, CAP.feedback)).filter(Boolean);
  return parts.length ? parts.join('\n') : null;
}

function toNumber(v: string | number | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One `questions[]` entry of mod_quiz_get_attempt_review: the rendered review HTML is cut into parts. */
export function mapReviewQuestion(raw: RawReviewQuestion): QuizReviewQuestion {
  const full = (raw.html ?? '').split('<script')[0] ?? ''; // everything after is Moodle's JS bootstrap
  const html = full.length > MAX_HTML ? full.slice(0, MAX_HTML) : full;
  const form = findDiv(html, 'formulation');
  const formulation = form ? html.slice(form.innerStart, form.innerEnd) : html;
  const qtext = findDiv(formulation, 'qtext');
  const rest = qtext ? formulation.slice(0, qtext.start) + formulation.slice(qtext.end) : formulation;
  const outcome = form ? html.slice(form.end) : html;
  const right = flatten(divMarkdown(outcome, 'rightanswer', CAP.rightAnswer));
  return {
    number: raw.questionnumber || String(raw.number ?? ''),
    type: raw.type ?? '',
    state: raw.state ?? '',
    status: raw.status ?? '',
    mark: toNumber(raw.mark),
    maxMark: toNumber(raw.maxmark),
    text: qtext ? htmlToMarkdown(formulation.slice(qtext.innerStart, qtext.innerEnd), { maxChars: CAP.text }) : '',
    answer: answerMarkdown(rest),
    rightAnswer: right || null,
    feedback: feedbackMarkdown(outcome),
  };
}

// ------------------------------------------------------------------ service

type ReviewPart = Pick<QuizReview, 'reviewedAttempt' | 'questions' | 'note'>;

type RawReview = { questions?: RawReviewQuestion[] | null };

interface Layout {
  questions: number;
  pages: number;
}

/** Question and page counts from an attempt's layout ("1,2,0,3,0"); null when the layout is missing or odd. */
function parseLayout(layout: string | null | undefined): Layout | null {
  if (!layout) return null;
  const slots = layout.split(',').map((t) => Number(t.trim()));
  if (slots.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const breaks = slots.filter((n) => n === 0).length;
  return { questions: slots.length - breaks, pages: Math.max(1, breaks) };
}

async function reviewPage(api: MoodleApi, attemptId: number, page: number): Promise<RawReviewQuestion[]> {
  const res = await api.call<RawReview>('mod_quiz_get_attempt_review', { attemptid: attemptId, page });
  return res?.questions ?? [];
}

/**
 * All questions in one call (page -1) — unless the layout says the quiz is longer than we show: then its pages are
 * read one by one until enough questions are in, so the HTML of the rest is never pulled.
 */
async function readQuestions(
  api: MoodleApi,
  req: { attemptId: number; layout: Layout | null },
): Promise<{ questions: RawReviewQuestion[]; total: number | null }> {
  const { layout } = req;
  if (!layout || layout.questions <= MAX_QUESTIONS) {
    return { questions: await reviewPage(api, req.attemptId, -1), total: null };
  }
  const questions: RawReviewQuestion[] = [];
  const lastPage = Math.min(layout.pages, MAX_PAGE_CALLS);
  for (let page = 0; page < lastPage && questions.length < MAX_QUESTIONS; page++) {
    questions.push(...(await reviewPage(api, req.attemptId, page)));
  }
  return { questions, total: layout.questions };
}

async function fetchReview(
  api: MoodleApi,
  req: { attemptId: number; attempt: number; layout: Layout | null },
): Promise<ReviewPart> {
  try {
    const { questions: raw, total } = await readQuestions(api, req);
    const kept = raw.slice(0, MAX_QUESTIONS);
    const all = total ?? raw.length;
    const note = kept.length < all ? `Only the first ${kept.length} of ${all} questions are included.` : null;
    return { reviewedAttempt: req.attempt, questions: kept.map(mapReviewQuestion), note };
  } catch (e) {
    if (!(e instanceof MoodleError)) throw e;
    const what = `attempt ${req.attempt}`;
    const note = `Moodle did not return the review of ${what} (${e.message}); the quiz may not allow it.`;
    return { reviewedAttempt: req.attempt, questions: [], note };
  }
}

function pickAttempt(finished: QuizAttempt[], wanted: number | undefined): QuizAttempt | null {
  if (wanted === undefined) return finished.at(-1) ?? null;
  const found = finished.find((a) => a.attempt === wanted);
  if (found) return found;
  const have = finished.map((a) => a.attempt).join(', ');
  throw new NotFound(`Attempt ${wanted} is not a finished attempt of this quiz (finished: ${have || 'none'}).`);
}

/**
 * Reviews one finished attempt (default: the latest). The quiz is resolved from the cmid by getActivity; its attempts
 * call (with the pre-5.0 fallback) is repeated with the same parameters, so the request memo answers it for free.
 */
export async function getQuizReview(
  ctx: ServiceContext,
  opts: { cmid: number; attempt?: number },
): Promise<QuizReview> {
  const detail = await getActivity(ctx, opts.cmid);
  if (detail.type !== 'quiz') {
    throw new InvalidInput(`Activity ${opts.cmid} is not a quiz. Use get_activity to see what it is.`);
  }
  const api = await ctx.moodle();
  const listed = await fetchUserAttempts(api, detail.instanceId);
  const attempts = detail.attempts.filter((a) => a.state === 'finished');
  const base = {
    cmid: detail.cmid,
    quizId: detail.instanceId,
    courseId: detail.courseId,
    courseName: detail.courseName,
    name: detail.name,
    url: detail.url,
    attempts,
  };
  const target = pickAttempt(attempts, opts.attempt);
  if (!target) {
    const note = 'No finished attempt yet, so there is nothing to review.';
    return { ...base, reviewedAttempt: null, questions: [], note };
  }
  const row = (listed?.attempts ?? []).find((a) => a.attempt === target.attempt);
  if (typeof row?.id !== 'number') throw new NotFound(`Attempt ${target.attempt} could not be found in Moodle.`);
  const layout = parseLayout(row.layout);
  return { ...base, ...(await fetchReview(api, { attemptId: row.id, attempt: target.attempt, layout })) };
}
