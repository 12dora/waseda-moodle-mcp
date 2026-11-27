/**
 * Parsers for the quiz pages of the web channel: `mod/quiz/view.php?id=<cmid>` (settings box, final grade line,
 * the Moodle 5 per-attempt summary cards, the start/continue button or the notices that prevent a new attempt) and
 * `mod/quiz/review.php?attempt=<id>` (one `div.que` per question). Text is read in Japanese and English only; other
 * languages give the language-independent parts (links, classes, numbers next to `/`).
 */

import { parseMoodleDate } from '../dates';
import { attr, findAll, findFirst, findForm, type HtmlElement, links, mainRegion, queryInt, text } from '../html';

type AttemptState = 'finished' | 'inprogress' | 'overdue' | 'abandoned';

interface ViewAttempt {
  id: number | null;
  attempt: number;
  state: AttemptState;
  timestart: number;
  timefinish: number;
  /** Raw marks of the attempt (marks row, or the grade row when the quiz shows no separate marks). */
  sumgrades: number | null;
  /** Maximum raw marks (sumgrades of the quiz) as printed next to the marks. */
  maxMarks: number | null;
  /** Maximum grade of the quiz as printed in the grade row. */
  maxGrade: number | null;
  /** Decimals Moodle printed the maximum with (the quiz's decimalpoints). */
  decimals: number | null;
}

interface QuizView {
  name: string;
  intro: string;
  courseId: number | null;
  timeopen: number | null;
  timeclose: number | null;
  /** Seconds; 0 = no limit. */
  timelimit: number;
  /** 0 = unlimited (no "attempts allowed" line). */
  attemptsAllowed: number;
  grademethod: number | null;
  finalGrade: { grade: number; max: number; decimals: number } | null;
  attempts: ViewAttempt[];
  /** The page offers "Attempt quiz" / "Re-attempt quiz" / "Continue your attempt". */
  canAttempt: boolean;
  /** Messages that explain why no attempt can be started (may be empty even when canAttempt is false). */
  notices: string[];
}

const NUM = '(\\d+(?:\\.\\d+)?)';
/** "24 / 30", "24/30", "24.00 out of 30.00": the ja and en grade formats (outofshort / outof / outofpercent). */
const OUT_OF = new RegExp(`${NUM}\\s*(?:/|out of)\\s*${NUM}`);
const DATE_OPEN = /開始|open/i;
const DATE_CLOSE = /終了|close/i;

const INFO_LABELS = {
  attempts: ['受験可能回数', 'attempts allowed'],
  timelimit: ['制限時間', 'time limit'],
  grademethod: ['評定方法', 'grading method'],
} as const;

/** quiz grademethod values: 1 highest, 2 average, 3 first, 4 last. */
const GRADE_METHODS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [1, ['最高評点', 'highest grade']],
  [2, ['平均評点', 'average grade']],
  [3, ['最初の受験', 'first attempt']],
  [4, ['最後の受験', 'last attempt']],
];

const STATE_TEXTS: ReadonlyArray<readonly [AttemptState, readonly string[]]> = [
  ['inprogress', ['進行中', 'in progress']],
  ['overdue', ['期限切れ', '期限超過', 'overdue']],
  ['abandoned', ['未提出', 'never submitted']],
  ['finished', ['終了', 'finished']],
];

const START_TEXTS = [
  '問題を受験する',
  '再受験する',
  '受験を続ける',
  'attempt quiz',
  're-attempt quiz',
  'continue your attempt',
];

const UNIT_SECONDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:days?|日)$/i, 86400],
  [/^(?:hours?|時間)$/i, 3600],
  [/^(?:mins?|minutes?|分)$/i, 60],
  [/^(?:secs?|seconds?|秒)$/i, 1],
];
const DURATION_PART = /(\d+)\s*(days?|hours?|minutes?|mins?|seconds?|secs?|日|時間|分|秒)/gi;

const lower = (s: string) => s.toLowerCase();
const hasAny = (s: string, words: readonly string[]) => words.some((w) => lower(s).includes(lower(w)));

function decimalsOf(n: string): number {
  const dot = n.indexOf('.');
  return dot < 0 ? 0 : n.length - dot - 1;
}

/** "24 / 30" → { value: 24, max: 30, decimals of the max }; null when the text holds no such pair. */
function outOf(s: string): { value: number; max: number; decimals: number } | null {
  const m = OUT_OF.exec(s);
  if (!m?.[1] || !m[2]) return null;
  return { value: Number(m[1]), max: Number(m[2]), decimals: decimalsOf(m[2]) };
}

/** "1 時間 30 分" / "1 hour 30 mins" → 5400; 0 when nothing is recognised. */
function durationSeconds(s: string): number {
  let total = 0;
  for (const m of s.matchAll(DURATION_PART)) {
    const unit = UNIT_SECONDS.find(([re]) => re.test(m[2] ?? ''));
    if (unit) total += Number(m[1]) * unit[1];
  }
  return total;
}

// ------------------------------------------------------------------ view page: settings

function strongText(line: string): string {
  const at = line.search(/<strong\b/i);
  if (at < 0) return '';
  const end = line.indexOf('</strong>', at);
  return end < 0 ? '' : line.slice(at, end);
}

/** `<div><strong>Opens:</strong> date</div>` lines; the label decides open vs close (ja 開始/終了, en open/close). */
function activityDates(html: string): { timeopen: number | null; timeclose: number | null } {
  const box = findFirst(html, { attr: 'data-region', value: 'activity-dates' });
  const out = { timeopen: null as number | null, timeclose: null as number | null };
  for (const line of box ? box.inner.split(/<\/div>/i) : []) {
    const label = text(strongText(line));
    const when = parseMoodleDate(text(line));
    if (when === null) continue;
    if (DATE_OPEN.test(label)) out.timeopen = when;
    else if (DATE_CLOSE.test(label)) out.timeclose = when;
  }
  return out;
}

interface InfoLines {
  attemptsAllowed: number;
  timelimit: number;
  grademethod: number | null;
}

function infoLines(main: string): InfoLines {
  const out: InfoLines = { attemptsAllowed: 0, timelimit: 0, grademethod: null };
  const box = findFirst(main, { attr: 'class', value: 'quizinfo', word: true });
  for (const p of box ? findAll(box.inner, { attr: 'class', tag: 'p' }) : []) {
    const line = text(p.inner);
    const sep = line.search(/[:：]/);
    if (sep < 0) continue;
    const label = line.slice(0, sep);
    const value = line.slice(sep + 1).trim();
    if (hasAny(label, INFO_LABELS.attempts)) out.attemptsAllowed = Number(/\d+/.exec(value)?.[0] ?? 0);
    else if (hasAny(label, INFO_LABELS.timelimit)) out.timelimit = durationSeconds(value);
    else if (hasAny(label, INFO_LABELS.grademethod)) {
      out.grademethod = GRADE_METHODS.find(([, words]) => hasAny(value, words))?.[0] ?? null;
    }
  }
  return out;
}

/** 「あなたの小テスト最終評点は 24 / 30 です。」 / "Your final grade for this quiz is 24.00/30.00." */
function finalGrade(main: string): QuizView['finalGrade'] {
  const box = findFirst(main, { attr: 'id', value: 'feedback' });
  if (!box) return null;
  const at = box.inner.search(/<h3\b/i);
  const end = box.inner.indexOf('</h3>', at);
  const line = at < 0 ? box.inner : box.inner.slice(at, end < 0 ? undefined : end);
  const got = outOf(text(line));
  return got ? { grade: got.value, max: got.max, decimals: got.decimals } : null;
}

// ------------------------------------------------------------------ view page: attempt cards

/** The cells of a summary table, in row order (header text is not used: its wording differs per language). */
function rowCells(table: string): string[] {
  return findAll(table, { attr: 'class', value: 'cell', word: true, tag: 'td' }).map((td) => td.inner);
}

function stateOf(statusText: string, hrefs: string[]): AttemptState | null {
  const byText = STATE_TEXTS.find(([, words]) => hasAny(statusText, words))?.[0];
  if (byText) return byText;
  if (hrefs.some((h) => h.includes('/mod/quiz/review.php'))) return 'finished';
  if (hrefs.some((h) => h.includes('/mod/quiz/attempt.php'))) return 'inprogress';
  return null;
}

function attemptId(hrefs: string[]): number | null {
  const href = hrefs.find((h) => h.includes('/mod/quiz/review.php') || h.includes('/mod/quiz/attempt.php'));
  return href ? queryInt(href, 'attempt') : null;
}

type Marks = Pick<ViewAttempt, 'sumgrades' | 'maxMarks' | 'maxGrade' | 'decimals'>;

/** Marks row ("8.00/10.00") before the grade row ("24.00 out of 30.00 (80%)"); the grade row alone when equal. */
function marksOf(cells: string[]): Marks {
  const pairs = cells.map((c) => outOf(text(c))).filter((p) => p !== null);
  const grade = pairs.at(-1);
  if (!grade) return { sumgrades: null, maxMarks: null, maxGrade: null, decimals: null };
  const marks = pairs.length > 1 ? pairs[0] : grade;
  const sumgrades = marks?.value ?? null;
  return { sumgrades, maxMarks: marks?.max ?? null, maxGrade: grade.max, decimals: grade.decimals };
}

function readCard(card: HtmlElement): ViewAttempt | null {
  const title = findFirst(card.inner, { attr: 'class', value: 'card-title', word: true });
  const number = Number(/(\d+)\s*$/.exec(text(title?.inner ?? ''))?.[1] ?? Number.NaN);
  const table = findFirst(card.inner, { attr: 'class', value: 'quizreviewsummary', word: true, tag: 'table' });
  if (!Number.isInteger(number) || !table) return null;
  const cells = rowCells(table.inner);
  const hrefs = links(card.inner);
  const state = stateOf(text(cells[0] ?? ''), hrefs);
  if (!state) return null;
  const dates = cells
    .slice(1)
    .map((c) => parseMoodleDate(text(c)))
    .filter((d) => d !== null);
  return {
    id: attemptId(hrefs),
    attempt: number,
    state,
    timestart: dates[0] ?? 0,
    timefinish: state === 'finished' || state === 'abandoned' ? (dates[1] ?? 0) : 0,
    ...marksOf(cells),
  };
}

function attemptCards(main: string): ViewAttempt[] {
  const cards = findAll(main, { attr: 'class', value: 'card', word: true, tag: 'div' });
  return cards
    .filter((c) => c.inner.split('quizreviewsummary').length === 2 && c.inner.includes('card-title'))
    .map(readCard)
    .filter((a) => a !== null);
}

// ------------------------------------------------------------------ view page: start button / notices

function canAttempt(main: string): boolean {
  if (findForm(main, '/mod/quiz/startattempt.php')) return true;
  const buttons = findAll(main, { attr: 'type', tag: 'button' }).map((b) => text(b.inner));
  return buttons.some((b) => START_TEXTS.some((t) => lower(b) === lower(t)));
}

function notices(main: string): string[] {
  const box = findFirst(main, { attr: 'class', value: 'quizattempt', word: true });
  const paragraphs = box ? findAll(box.inner, { attr: 'class', tag: 'p' }).map((p) => text(p.inner)) : [];
  const alerts = findAll(main, { attr: 'class', value: 'alert', word: true }).map((a) => text(a.inner));
  return [...paragraphs, ...alerts].filter(Boolean);
}

export function parseQuizView(html: string, pageCourseId: number | null): QuizView {
  const main = mainRegion(html);
  const info = findFirst(main, { attr: 'data-region', value: 'activity-information' });
  const intro = findFirst(main, { attr: 'id', value: 'intro' });
  return {
    name: info ? attr(info.attrs, 'data-activityname') : '',
    intro: intro?.inner.trim() ?? '',
    courseId: pageCourseId,
    ...activityDates(main),
    ...infoLines(main),
    finalGrade: finalGrade(main),
    attempts: attemptCards(main),
    canAttempt: canAttempt(main),
    notices: notices(main),
  };
}

// ------------------------------------------------------------------ review page

/** `div.que` state class → question_state name as the web service reports it. */
const STATE_CLASS: Readonly<Record<string, string>> = {
  correct: 'gradedright',
  partiallycorrect: 'gradedpartial',
  incorrect: 'gradedwrong',
  notanswered: 'gaveup',
  requiresgrading: 'needsgrading',
  answersaved: 'complete',
  notyetanswered: 'todo',
  invalidanswer: 'invalid',
};

interface ReviewQuestion {
  slot: number;
  type: string;
  number: number | null;
  questionnumber: string;
  state: string;
  status: string;
  mark: number | null;
  maxmark: number | null;
  html: string;
}

function gradeOf(grade: string): { mark: number | null; maxmark: number | null } {
  const nums = [...grade.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (nums.length >= 2) return { mark: nums[0] ?? null, maxmark: nums[1] ?? null };
  return { mark: null, maxmark: nums[0] ?? null }; // "Marked out of 1.00": not graded yet / marks hidden
}

function readQuestion(que: HtmlElement): ReviewQuestion | null {
  const slot = Number(/^question-\d+-(\d+)$/.exec(attr(que.attrs, 'id'))?.[1] ?? Number.NaN);
  if (!Number.isInteger(slot)) return null;
  const classes = attr(que.attrs, 'class').split(/\s+/).filter(Boolean);
  const stateClass = classes[3] ?? '';
  const info = findFirst(que.inner, { attr: 'class', value: 'info', word: true })?.inner ?? '';
  const qno = text(findFirst(info, { attr: 'class', value: 'qno', word: true })?.inner ?? '');
  const type = classes[1] ?? '';
  const grade = text(findFirst(info, { attr: 'class', value: 'grade', word: true })?.inner ?? '');
  const n = Number(qno);
  return {
    slot,
    type,
    number: qno && Number.isInteger(n) ? n : null,
    questionnumber: qno || (type === 'description' ? 'i' : ''),
    state: STATE_CLASS[stateClass] ?? stateClass,
    status: text(findFirst(info, { attr: 'class', value: 'state', word: true })?.inner ?? ''),
    ...gradeOf(grade),
    html: que.outer,
  };
}

export function parseReviewPage(html: string): ReviewQuestion[] {
  const main = mainRegion(html);
  return findAll(main, { attr: 'class', value: 'que', word: true, tag: 'div' })
    .map(readQuestion)
    .filter((q) => q !== null);
}
