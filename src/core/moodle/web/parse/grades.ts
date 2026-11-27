/**
 * Parsers for the two grade pages of the web channel: the overview report (`grade/report/overview/index.php`, one row
 * per course) and the user report (`course/user.php?mode=grade`, `table.user-grade`). Everything is located by class
 * names, ids and link targets, so the interface language does not matter; values are the cell texts as shown.
 */

import {
  attr,
  type ElementQuery,
  findAll,
  findFirst,
  type HtmlElement,
  links,
  mainRegion,
  queryInt,
  text,
} from '../html';

const byClass = (word: string, tag?: string): ElementQuery => ({ attr: 'class', value: word, word: true, tag });

const present = <T>(v: T | null): v is T => v !== null;

/** Every `<tr>` of a table's content (Moodle report tables put a class attribute on each body row). */
const bodyRows = (table: string): HtmlElement[] => findAll(table, { attr: 'class', tag: 'tr' });

// ------------------------------------------------------------------ overview report

const COURSE_LINK = /\/(?:course\/user\.php|grade\/report\/user\/index\.php)\?/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

function cellText(row: string, column: string): string {
  const cell = findFirst(row, byClass(column, 'td'));
  return cell ? text(cell.inner) : '';
}

function overviewRow(row: HtmlElement) {
  const href = links(row.inner).find((h) => COURSE_LINK.test(h));
  const courseid = href ? queryInt(href, 'id') : null;
  if (courseid === null) return null; // filler rows ('emptyrow') have no course link
  const grade = cellText(row.inner, 'c1') || '-';
  const rank = cellText(row.inner, 'c2');
  return {
    courseid,
    grade,
    // Only a bare number is the raw grade; percentages, letters and '-' are display text.
    rawgrade: PLAIN_NUMBER.test(grade) ? grade : null,
    rank: /^\d+$/.test(rank) ? Number(rank) : undefined,
  };
}

/** The course rows of the overview report ([] when the page has no table, e.g. no gradable course). */
export function parseOverviewGrades(html: string) {
  const table = findFirst(mainRegion(html), { attr: 'id', value: 'overview-grade' });
  return table ? bodyRows(table.inner).map(overviewRow).filter(present) : [];
}

// ------------------------------------------------------------------ user report

const MODULE_LINK = /\/mod\/([a-z0-9_]+)\/view\.php\?/;
/** Activity icons are served as `theme/image.php/<theme>/<modname>/<rev>/monologo`. */
const MODULE_ICON = /\/theme\/image\.php\/[^/"]+\/([a-z0-9_]+)\/-?\d+\/monologo/;
/** Parts of a cell that are controls or screen-reader text, not the value. */
const NOISE = ['action-menu', 'visually-hidden', 'sr-only', 'accesshide'];

const VALUE_COLUMNS = [
  ['gradeformatted', 'column-grade'],
  ['rangeformatted', 'column-range'],
  ['percentageformatted', 'column-percentage'],
  ['weightformatted', 'column-weight'],
  ['lettergradeformatted', 'column-lettergrade'],
] as const;

/** `html` without the elements that carry the class `word`. */
function without(html: string, word: string): string {
  let out = '';
  let from = 0;
  for (const el of findAll(html, byClass(word))) {
    if (el.start < from) continue; // inside an element already removed
    out += html.slice(from, el.start);
    from = el.start + el.outer.length;
  }
  return out + html.slice(from);
}

const clean = (html: string): string => NOISE.reduce((acc, word) => without(acc, word), html);

/** What the name cell wraps: an activity or manual item, or the total of a category or of the course. */
function rowKind(header: string): 'course' | 'category' | 'item' | null {
  if (findFirst(header, byClass('courseitem'))) return 'course';
  if (findFirst(header, byClass('categoryitem'))) return 'category';
  return findFirst(header, byClass('item', 'div')) ? 'item' : null; // category headings have none of these
}

/** An activity item names its module in the link to it (an unlinked one in its icon); anything else is manual. */
function itemSource(title: HtmlElement | null, header: string) {
  const href = title?.tag === 'a' ? attr(title.attrs, 'href') : '';
  const linked = MODULE_LINK.exec(href)?.[1];
  const cmid = linked ? queryInt(href, 'id') : null;
  if (linked && cmid !== null) return { itemtype: 'mod', itemmodule: linked, cmid, iteminstance: cmid };
  const icon = MODULE_ICON.exec(header)?.[1];
  return icon ? { itemtype: 'mod', itemmodule: icon } : { itemtype: 'manual' };
}

function itemIdentity(kind: 'course' | 'category' | 'item', header: string) {
  // Totals have no item name in the web service either.
  if (kind !== 'item') return { itemname: null, itemtype: kind };
  const title = findFirst(header, byClass('gradeitemheader'));
  return { itemname: title ? text(title.inner) : '', ...itemSource(title, header) };
}

/** The feedback cell's HTML; '' for the placeholders Moodle shows when there is none. */
function feedbackHtml(row: string): string {
  const cell = findFirst(row, byClass('column-feedback', 'td'));
  if (!cell) return '';
  const html = clean(cell.inner).trim();
  const shown = text(html);
  const blank = (shown === '' || shown === '-') && !/<(?:img|video|audio|iframe)\b/i.test(html);
  return blank ? '' : html;
}

type ValueCells = Partial<Record<(typeof VALUE_COLUMNS)[number][0], string>>;

/** The texts of the value columns the report shows (a course chooses its columns). */
function valueCells(row: string): ValueCells {
  const out: ValueCells = {};
  for (const [field, column] of VALUE_COLUMNS) {
    const cell = findFirst(row, byClass(column, 'td'));
    if (cell) out[field] = text(clean(cell.inner));
  }
  return out;
}

function reportRow(row: HtmlElement) {
  const header = findFirst(row.inner, byClass('column-itemname', 'th'));
  const kind = header ? rowKind(header.inner) : null;
  if (!header || !kind) return null;
  return { ...itemIdentity(kind, header.inner), ...valueCells(row.inner), feedback: feedbackHtml(row.inner) };
}

/** The grade items of the user report in page order; null when the page holds no user report table. */
export function parseUserReport(html: string) {
  const table = findFirst(mainRegion(html), byClass('user-grade', 'table'));
  return table ? bodyRows(table.inner).map(reportRow).filter(present) : null;
}
