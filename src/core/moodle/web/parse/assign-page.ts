/**
 * mod/assign pages read back into web-service shapes (mod_assign_get_assignments / get_submission_status):
 * the view page (intro, activity dates, submission status table, feedback table, action buttons), the edit form
 * (action=editsubmission: plugins, filemanager limits, submission statement) and the submit confirm form
 * (action=submit). Rows are told apart by Moodle's cell classes and plugin classes, and by what a cell holds (a date),
 * never by their labels, except for the activity dates, which only exist as labelled text.
 */

import { parseMoodleDate } from '../dates';
import { attr, findAll, findFirst, formFields, type HtmlElement, links, mainRegion, text } from '../html';

interface PageFile {
  filename: string;
  filepath: string;
  fileurl: string;
  timemodified?: number;
}

interface AssignPlugin {
  type: string;
  editorfields?: Array<{ name: string; text: string; format: number }>;
  fileareas?: Array<{ area: string; files: PageFile[] }>;
}

interface AssignStatusTable {
  status: 'new' | 'draft' | 'submitted' | 'reopened';
  timemodified: number | null;
  plugins: AssignPlugin[];
  gradingstatus: 'graded' | 'notgraded' | null;
  extensionduedate: number | null;
}

interface AssignFeedbackTable {
  gradefordisplay: string | null;
  gradeddate: number | null;
  plugins: AssignPlugin[];
}

export interface AssignView {
  name: string;
  courseId: number | null;
  intro: string;
  introFiles: PageFile[];
  activityFiles: PageFile[];
  opensAt: number | null;
  dueAt: number | null;
  status: AssignStatusTable | null;
  feedback: AssignFeedbackTable | null;
  canEdit: boolean;
  canSubmit: boolean;
  locked: boolean;
}

export interface AssignForm {
  /** Path of the form action relative to the site (what WebSession.page takes). */
  action: string;
  fields: Map<string, string>;
  /** The submission statement checkbox (HTML of its label), null when the form has none. */
  statement: string | null;
  submitLabel: string | null;
}

export interface AssignEditForm extends AssignForm {
  onlinetext: boolean;
  file: boolean;
  maxFiles: number | null;
  maxBytes: number | null;
  /** Accepted types as the filepicker lists them ('' = any type). */
  fileTypes: string;
}

// ------------------------------------------------------------------ files

const PLUGINFILE = /\/pluginfile\.php\/(\d+)\/([^/?#]+)\/([^/?#]+)\/(\d+)(\/[^?#]*)?\/([^/?#]+)(?:[?#]|$)/;

const decodePart = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** pluginfile links of one component file area, in document order, without the query (forcedownload). */
function pluginFiles(html: string, component: string, area: string): PageFile[] {
  const out: PageFile[] = [];
  const seen = new Set<string>();
  for (const href of links(html)) {
    const m = PLUGINFILE.exec(href);
    if (!m || m[2] !== component || m[3] !== area) continue;
    const fileurl = href.split(/[?#]/)[0] ?? href;
    if (seen.has(fileurl)) continue;
    seen.add(fileurl);
    out.push({ filename: decodePart(m[6] ?? ''), filepath: decodePart(`${m[5] ?? ''}/`), fileurl });
  }
  return out;
}

/** Submission files with the time Moodle prints under each one (`.fileuploadsubmissiontime`), when it does. */
function submissionFiles(html: string): PageFile[] {
  const files = pluginFiles(html, 'assignsubmission_file', 'submission_files');
  const times = findAll(html, { attr: 'class', value: 'fileuploadsubmissiontime', word: true });
  if (times.length !== files.length) return files;
  return files.map((f, i) => {
    const t = parseMoodleDate(text(times[i]?.inner ?? ''));
    return t === null ? f : { ...f, timemodified: t };
  });
}

// ------------------------------------------------------------------ tables

interface Row {
  /** Classes of the value cell without Moodle's layout classes. */
  classes: string[];
  html: string;
  text: string;
  plugin: { kind: 'submission' | 'feedback'; type: string; html: string } | null;
}

const LAYOUT = new Set(['cell', 'c0', 'c1', 'lastcol']);
const PLUGIN_CLASS = /class="[^"]*?\bsummary_assign(submission|feedback)_([a-z0-9]+)_\d+/;

/** Elements not inside an earlier element of the list (rows of nested tables in submitted text are dropped). */
function topLevel(els: HtmlElement[]): HtmlElement[] {
  const out: HtmlElement[] = [];
  let end = -1;
  for (const el of els) {
    if (el.start < end) continue;
    out.push(el);
    end = el.start + el.outer.length;
  }
  return out;
}

function rowPlugin(td: string): Row['plugin'] {
  const m = PLUGIN_CLASS.exec(td);
  if (!m) return null;
  return { kind: m[1] === 'feedback' ? 'feedback' : 'submission', type: m[2] ?? '', html: td };
}

function tableRows(html: string): Row[] {
  const rows: Row[] = [];
  for (const tr of topLevel(findAll(html, { attr: 'class', tag: 'tr' }))) {
    const td = findFirst(tr.inner, { attr: 'class', tag: 'td' });
    if (!td) continue;
    const classes = attr(td.attrs, 'class')
      .split(/\s+/)
      .filter((c) => c && !LAYOUT.has(c));
    rows.push({ classes, html: td.inner, text: text(td.inner), plugin: rowPlugin(td.inner) });
  }
  return rows;
}

const blockOf = (html: string, cls: string): HtmlElement | null =>
  findFirst(html, { attr: 'class', value: cls, word: true });

/** The element whose class attribute contains `marker` (first occurrence), or null. */
function boxWith(html: string, marker: string): HtmlElement | null {
  const at = html.indexOf(marker);
  const tag = at < 0 ? -1 : html.lastIndexOf('<', at);
  return tag < 0 ? null : findFirst(html.slice(tag), { attr: 'class' });
}

/** The full text of a plugin (the expanded `full_…` box when Moodle truncated the summary). */
function pluginText(kind: string, type: string, td: string): string {
  const box = boxWith(td, `full_assign${kind}_${type}_`) ?? boxWith(td, `summary_assign${kind}_${type}_`);
  const inner = box?.inner ?? td;
  const body = blockOf(inner, 'no-overflow')?.inner ?? inner;
  return body
    .replace(/<a\b[^>]*\bexpandsummaryicon\b[^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>/gi, '')
    .trim();
}

const EDITOR_PLUGINS: Record<string, string> = { onlinetext: 'onlinetext', comments: 'comments' };
const FILE_AREAS: Record<string, [string, string]> = {
  'submission:file': ['assignsubmission_file', 'submission_files'],
  'feedback:file': ['assignfeedback_file', 'feedback_files'],
  'feedback:editpdf': ['assignfeedback_editpdf', 'download'],
};

function toPlugin(p: NonNullable<Row['plugin']>): AssignPlugin | null {
  const area = FILE_AREAS[`${p.kind}:${p.type}`];
  if (area) {
    const files = p.type === 'file' && p.kind === 'submission' ? submissionFiles(p.html) : pluginFiles(p.html, ...area);
    return { type: p.type, fileareas: [{ area: area[1], files }] };
  }
  const field = EDITOR_PLUGINS[p.type];
  // submission comments are a separate (ajax) feature: no text in the table
  if (!field || (p.kind === 'submission' && p.type === 'comments')) return null;
  return { type: p.type, editorfields: [{ name: field, text: pluginText(p.kind, p.type, p.html), format: 1 }] };
}

const plugins = (rows: Row[]): AssignPlugin[] =>
  rows.flatMap((r) => (r.plugin ? [toPlugin(r.plugin)] : [])).filter((p): p is AssignPlugin => p !== null);

const STATUS_CLASS = /^submissionstatus(new|draft|submitted|reopened)$/;
const GRADING_CLASS: Record<string, 'graded' | 'notgraded'> = {
  submissiongraded: 'graded',
  submissionnotgraded: 'notgraded',
};

const gradingOf = (r: Row): 'graded' | 'notgraded' | null =>
  r.classes.map((c) => GRADING_CLASS[c]).find((g) => g !== undefined) ?? null;

/**
 * Plain rows after the grading status holding a date or '-': the last is "last modified", an earlier one the
 * extension due date.
 */
function rowDates(rows: Row[], from: number): { modified: number | null; extension: number | null } {
  const dated = rows
    .slice(from)
    .filter((r) => !r.plugin && r.classes.length === 0 && (r.text === '-' || parseMoodleDate(r.text) !== null));
  const last = dated.at(-1);
  const earlier = dated.slice(0, -1).find((r) => parseMoodleDate(r.text) !== null);
  return {
    modified: last && last.text !== '-' ? parseMoodleDate(last.text) : null,
    extension: earlier ? parseMoodleDate(earlier.text) : null,
  };
}

function parseStatusTable(html: string): AssignStatusTable | null {
  const box = blockOf(html, 'submissionstatustable');
  if (!box) return null;
  const rows = tableRows(box.inner);
  const gradingAt = rows.findIndex((r) => gradingOf(r) !== null);
  const statusClass = rows.flatMap((r) => r.classes).find((c) => STATUS_CLASS.test(c));
  const statusAt = rows.findIndex((r) => r.classes.some((c) => STATUS_CLASS.test(c)));
  const dates = rowDates(rows, Math.max(gradingAt, statusAt) + 1);
  return {
    // no class: Moodle prints "no submission yet" without one
    status: (STATUS_CLASS.exec(statusClass ?? '')?.[1] as AssignStatusTable['status'] | undefined) ?? 'new',
    timemodified: dates.modified,
    plugins: plugins(rows.filter((r) => r.plugin?.kind === 'submission')),
    gradingstatus: gradingAt >= 0 ? gradingOf(rows[gradingAt] as Row) : null,
    extensionduedate: dates.extension,
  };
}

/** Moodle prints the grade, then "graded on" (a date), then the grader, then one row per feedback plugin. */
function parseFeedbackTable(html: string): AssignFeedbackTable | null {
  const box = blockOf(html, 'feedbacktable');
  if (!box) return null;
  const rows = tableRows(box.inner);
  const plain = rows.filter((r) => !r.plugin);
  const dateAt = plain.findIndex((r) => parseMoodleDate(r.text) !== null);
  return {
    gradefordisplay: dateAt > 0 ? (plain[0]?.html ?? null) : null,
    gradeddate: dateAt >= 0 ? parseMoodleDate(plain[dateAt]?.text ?? '') : null,
    plugins: plugins(rows.filter((r) => r.plugin?.kind === 'feedback')),
  };
}

// ------------------------------------------------------------------ view page

const OPENS = /^(?:開始|Opens?|Opened)/i;
const DUE = /^(?:期限|Due)/i;

/** `<strong>Label:</strong> date` pairs of the activity dates block (ja + en labels). */
function activityDates(html: string): { opensAt: number | null; dueAt: number | null } {
  const box = findFirst(html, { attr: 'data-region', value: 'activity-dates' });
  const out = { opensAt: null as number | null, dueAt: null as number | null };
  if (!box) return out;
  for (const m of box.inner.matchAll(/<strong>([^<]*)<\/strong>([^<]*)/g)) {
    const label = text(m[1] ?? '');
    const at = parseMoodleDate(text(m[2] ?? ''));
    if (OPENS.test(label)) out.opensAt = at;
    else if (DUE.test(label)) out.dueAt = at;
  }
  return out;
}

/** The `action` values of the page's buttons (hidden inputs of single-button forms) and links. */
function pageActions(html: string): Set<string> {
  const out = new Set<string>();
  for (const input of findAll(html, { attr: 'name', value: 'action', tag: 'input' })) {
    out.add(attr(input.attrs, 'value'));
  }
  for (const href of links(html)) {
    const m = /[?&]action=([a-z]+)(?:[&#]|$)/.exec(href.replace(/&amp;/g, '&'));
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

export function parseAssignView(html: string, courseId: number | null): AssignView {
  const main = mainRegion(html);
  const intro = findFirst(main, { attr: 'id', value: 'intro' })?.inner ?? '';
  const actions = pageActions(main);
  const info = findFirst(main, { attr: 'data-region', value: 'activity-information' });
  return {
    name: info ? attr(info.attrs, 'data-activityname') : '',
    courseId,
    intro: intro.trim(),
    introFiles: pluginFiles(intro, 'mod_assign', 'introattachment'),
    activityFiles: pluginFiles(main, 'mod_assign', 'activityattachment'),
    ...activityDates(main),
    status: parseStatusTable(main),
    feedback: parseFeedbackTable(main),
    canEdit: actions.has('editsubmission'),
    canSubmit: actions.has('submit'),
    locked: blockOf(main, 'submissionlocked') !== null,
  };
}

// ------------------------------------------------------------------ forms

function relativeAction(action: string, baseUrl: string): string | null {
  const a = action.replace(/&amp;/g, '&');
  if (a.startsWith(`${baseUrl}/`)) return a.slice(baseUrl.length);
  return a.startsWith('/') && !a.startsWith('//') ? a : null;
}

/** The Moodle form whose quickform marker is `_qf__<qf>`. */
function readForm(html: string, qf: string, baseUrl: string): AssignForm | null {
  const form = findAll(html, { attr: 'action', tag: 'form' }).find((f) => f.inner.includes(`name="_qf__${qf}"`));
  const action = form ? relativeAction(attr(form.attrs, 'action'), baseUrl) : null;
  if (!form || !action) return null;
  const box = findFirst(form.inner, { attr: 'name', value: 'submissionstatement', tag: 'input' });
  const label = box ? findFirst(form.inner, { attr: 'for', value: 'id_submissionstatement', tag: 'label' }) : null;
  const button = findFirst(form.inner, { attr: 'name', value: 'submitbutton', tag: 'input' });
  return {
    action,
    fields: formFields(form.inner),
    statement: box ? (label?.inner.trim() ?? '') : null,
    submitLabel: button ? attr(button.attrs, 'value') : null,
  };
}

const intOf = (s: string | undefined): number | null => {
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** The submission filemanager's init options (`M.form_filemanager.init(Y, {…"target":"id_files_filemanager"…})`). */
function fileManagerOptions(html: string): Pick<AssignEditForm, 'maxFiles' | 'maxBytes' | 'fileTypes'> {
  const target = html.indexOf('"target":"id_files_filemanager"');
  const start = target < 0 ? -1 : html.lastIndexOf('M.form_filemanager.init(', target);
  if (start < 0) return { maxFiles: null, maxBytes: null, fileTypes: '' };
  const end = html.indexOf('"return_types"', target);
  const opts = html.slice(start, end < 0 ? target + 4000 : end);
  const types = /"accepted_types":(\[[^\]]*\]|"[^"]*")/.exec(opts)?.[1] ?? '[]';
  let list: unknown;
  try {
    list = JSON.parse(types);
  } catch {
    list = [];
  }
  return {
    maxFiles: intOf(/"maxfiles":"?(-?\d+)/.exec(opts)?.[1]),
    maxBytes: intOf(/"maxbytes":"?(-?\d+)/.exec(opts)?.[1]),
    fileTypes: Array.isArray(list) ? list.filter((t) => typeof t === 'string').join(',') : String(list),
  };
}

export function parseEditForm(html: string, baseUrl: string): AssignEditForm | null {
  const form = readForm(html, 'mod_assign_submission_form', baseUrl);
  if (!form) return null;
  const file = form.fields.has('files_filemanager');
  return {
    ...form,
    onlinetext: form.fields.has('onlinetext_editor[text]'),
    file,
    ...(file ? fileManagerOptions(html) : { maxFiles: null, maxBytes: null, fileTypes: '' }),
  };
}

export const parseSubmitForm = (html: string, baseUrl: string): AssignForm | null =>
  readForm(html, 'mod_assign_confirm_submission_form', baseUrl);

/** Validation messages of a re-rendered form and error notifications, as plain text. */
export function formErrors(html: string): string[] {
  const main = mainRegion(html);
  const found = [
    ...findAll(main, { attr: 'class', value: 'invalid-feedback', word: true }),
    ...findAll(main, { attr: 'class', value: 'alert-danger', word: true }),
    ...findAll(main, { attr: 'class', value: 'alert-error', word: true }),
  ];
  const out: string[] = [];
  for (const el of found) {
    const t = text(el.inner).slice(0, 300);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
