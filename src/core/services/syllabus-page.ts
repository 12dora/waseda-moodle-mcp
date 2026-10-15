/**
 * Parser for the public Waseda syllabus detail page (JAA104, ja and en). Cells are found by their <th scope="row">
 * header text (the page has two label sets and a few pages omit rows), never by position: the page is hand-edited
 * HTML (unclosed rows, free text where other pages have a nested table), so every field is optional.
 */

import { decodeEntities, htmlToMarkdown } from '../html';

export type SyllabusLang = 'ja' | 'en';

interface GradingRow {
  method: string; // e.g. 試験 / Exam
  weight: number | null; // percent
  criteria: string;
}

interface SyllabusSession {
  no: string; // "1", "2", ...
  title: string;
  body: string; // the rest of the cell (topics, per-session preparation), markdown
}

/** Single-line cells: label (ja, en) per field. */
const INLINE_LABELS = {
  title: ['科目名', 'Course Title'],
  subtitle: ['副題', 'Subtitle'],
  year: ['開講年度', 'Year'],
  school: ['開講箇所', 'School'],
  termDayPeriod: ['学期曜日時限', 'Term/Day/Period'],
  category: ['科目区分', 'Category'],
  credits: ['単位数', 'Credits'],
  classroom: ['使用教室', 'Classroom'],
  campus: ['キャンパス', 'Campus'],
  language: ['授業で使用する言語', 'Main Language'],
  modality: ['授業方法区分', 'Class Modality Categories'],
} as const;

/** Rich-text cells and the characters kept of each (the page is cached and sent to a model). */
const TEXT_LABELS = {
  outline: ['授業概要', 'Course Outline'],
  objectives: ['授業の到達目標', 'Objectives'],
  prepost: ['事前・事後学習の内容', 'before/after course of study'],
  textbooks: ['教科書', 'Textbooks'],
  references: ['参考文献', 'Reference', 'References'],
  notes: ['備考・関連URL', 'Note/URL', 'Notes/URL', 'Remarks/URL', 'Notes', 'Note', 'Remarks'],
} as const;

const TEXT_MAX = { outline: 4000, objectives: 3000, prepost: 3000, textbooks: 2000, references: 1500, notes: 2500 };

const INSTRUCTOR_LABELS = ['担当教員', 'Instructor'];
const PLAN_LABELS = ['授業計画', 'Course Schedule'];
const GRADING_LABELS = ['成績評価方法', 'Evaluation'];

const PLAN_TEXT_MAX = 6000;
const SESSION_BODY_MAX = 800;
const MAX_SESSIONS = 40;
const GRADING_CRITERIA_MAX = 800;
const GRADING_TEXT_MAX = 2500;

type InlineKey = keyof typeof INLINE_LABELS;
type TextKey = keyof typeof TEXT_LABELS;

export type SyllabusPage = {
  lang: SyllabusLang; // language of the page the text comes from
  updatedAt: string | null; // 最終更新日時 as printed (JST), e.g. "2026/05/15 12:37:49"
  instructors: string[];
  sessions: SyllabusSession[]; // per-session list when the plan is a table; [] for free-text plans
  planText: string; // the plan as markdown when it has no per-session table
  grading: GradingRow[]; // [] when the cell is free text
  gradingText: string; // the cell as markdown when it has no table
} & Record<InlineKey, string | null> &
  Record<TextKey, string>;

// ------------------------------------------------------------------ cells by header

type Cells = Map<string, string>;

const normLabel = (s: string) =>
  decodeEntities(s.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, '')
    .toLowerCase();
const inlineText = (raw: string) =>
  decodeEntities(raw.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** `<th scope="row">label</th>` directly followed by a `<td>`; nested-table headers carry no scope. */
const ROW_HEADER_RE = /<th\b[^>]*\bscope="row"[^>]*>((?:(?!<\/th>)[\s\S])*)<\/th>\s*<td\b[^>]*>/g;
/** Every block of the page ends with this wrapper, so the last cell of a table stops here. */
const BLOCK_END = '<div class="cbd-bkbottom"';

/** label (normalised) -> raw HTML from after its `<td>` up to the next row header / end of the block. */
function labelledCells(html: string): Cells {
  const marks = [...html.matchAll(ROW_HEADER_RE)];
  const cells: Cells = new Map();
  marks.forEach((m, i) => {
    const label = normLabel(m[1] ?? '');
    const start = (m.index ?? 0) + m[0].length;
    const blockEnd = html.indexOf(BLOCK_END, start);
    const stops = [marks[i + 1]?.index ?? html.length, blockEnd < 0 ? html.length : blockEnd];
    if (!cells.has(label)) cells.set(label, html.slice(start, Math.min(...stops)));
  });
  return cells;
}

function cellOf(cells: Cells, labels: readonly string[]): string | undefined {
  for (const label of labels) {
    const raw = cells.get(normLabel(label));
    if (raw !== undefined) return raw;
  }
  return undefined;
}

function readFields<K extends string, V>(
  cells: Cells,
  labels: Record<K, readonly string[]>,
  read: (raw: string | undefined, key: K) => V,
): Record<K, V> {
  const out = {} as Record<K, V>;
  for (const key of Object.keys(labels) as K[]) out[key] = read(cellOf(cells, labels[key]), key);
  return out;
}

// ------------------------------------------------------------------ plan + grading

const SESSION_NO_RE = /<td\b[^>]*nowrap[^>]*>\s*([^<]{1,20}?)\s*[:：]?\s*<\/td>/g;

function parseSession(no: string, chunk: string): SyllabusSession {
  const [first = '', ...rest] = htmlToMarkdown(chunk, { maxChars: SESSION_BODY_MAX }).split('\n');
  return { no, title: first.trim(), body: rest.join('\n').trim() };
}

/** `1:` cells each followed by a title + topics table -> sessions; anything else stays free text. */
function parsePlan(raw: string): Pick<SyllabusPage, 'sessions' | 'planText'> {
  const marks = [...raw.matchAll(SESSION_NO_RE)];
  if (marks.length === 0) return { sessions: [], planText: htmlToMarkdown(raw, { maxChars: PLAN_TEXT_MAX }) };
  const sessions = marks.slice(0, MAX_SESSIONS).map((m, i) => {
    const end = marks[i + 1]?.index ?? raw.length;
    return parseSession(m[1] ?? '', raw.slice((m.index ?? 0) + m[0].length, end));
  });
  return { sessions, planText: '' };
}

const WEIGHT_RE = /(\d+(?:\.\d+)?)\s*[%％]/;
const TD_RE = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
const TR_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;

function gradingRow(cells: string[]): GradingRow | null {
  const [method, weight, criteria] = cells;
  if (method === undefined || weight === undefined || criteria === undefined) return null;
  const share = WEIGHT_RE.exec(inlineText(weight));
  return {
    method: inlineText(method)
      .replace(/[:：]$/, '')
      .trim(),
    weight: share?.[1] ? Number(share[1]) : null,
    criteria: htmlToMarkdown(criteria, { maxChars: GRADING_CRITERIA_MAX }),
  };
}

/** Table rows (method | weight | criteria); a free-text cell yields no rows and is kept as `gradingText`. */
function parseGrading(raw: string): Pick<SyllabusPage, 'grading' | 'gradingText'> {
  const grading: GradingRow[] = [];
  for (const tr of raw.matchAll(TR_RE)) {
    const cells = [...(tr[1] ?? '').matchAll(TD_RE)].map((c) => c[1] ?? '');
    const row = gradingRow(cells);
    if (row) grading.push(row);
  }
  const gradingText = grading.length > 0 ? '' : htmlToMarkdown(raw, { maxChars: GRADING_TEXT_MAX });
  return { grading, gradingText };
}

// ------------------------------------------------------------------ page

const UPDATED_RE = /(?:最終更新日時|Latest Update)\s*[：:]\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})/;
const INSTRUCTOR_SPLIT_RE = /[、／;；，]/;

/** Text of a single-line cell: the range of a cell may run on into the markup of the next (unlabelled) header. */
const firstCell = (raw: string | undefined) => inlineText(raw?.split('</td>')[0] ?? '');

const instructorsOf = (raw: string | undefined) =>
  firstCell(raw)
    .split(INSTRUCTOR_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);

/** Whether the page is a syllabus at all: the error and "no syllabus" pages have none of these rows. */
const KEY_LABELS = [INLINE_LABELS.title, TEXT_LABELS.outline, TEXT_LABELS.objectives, PLAN_LABELS, GRADING_LABELS];

/** null = the HTML has no syllabus rows (empty / error page). */
export function parseSyllabusPage(html: string, lang: SyllabusLang): SyllabusPage | null {
  const cells = labelledCells(html);
  if (!KEY_LABELS.some((labels) => cellOf(cells, labels) !== undefined)) return null;
  const inline = readFields(cells, INLINE_LABELS, (raw) => firstCell(raw) || null);
  const text = readFields(cells, TEXT_LABELS, (raw, key) => htmlToMarkdown(raw, { maxChars: TEXT_MAX[key] }));
  return {
    ...inline,
    ...text,
    lang,
    updatedAt: UPDATED_RE.exec(html)?.[1] ?? null,
    instructors: instructorsOf(cellOf(cells, INSTRUCTOR_LABELS)),
    ...parsePlan(cellOf(cells, PLAN_LABELS) ?? ''),
    ...parseGrading(cellOf(cells, GRADING_LABELS) ?? ''),
  };
}
