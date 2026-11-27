/**
 * The course page (`course/view.php?id=<course>`) and the cm snippets of `core_course_get_module`, read for what the
 * course-format state (`core_courseformat_get_state`) does not carry: section summaries, module descriptions
 * (labels, "show description"), activity dates and completion. One pass over the page: every `data-for` element
 * (`section` containers and `cmitem` modules); each item is cut before the first nested item, so a subsection's
 * module never takes the dates or completion of the modules inside its delegated section.
 */

import { parseMoodleDate } from '../dates';
import { attr, findAll, findFirst, type HtmlElement, links, text } from '../html';

interface PageDate {
  label: string;
  timestamp: number;
  dataid: string | null;
}

/** 0 none, 1 manual, 2 automatic (core_course_get_contents `completion`). */
type Tracking = 0 | 1 | 2;

export interface PageCm {
  id: number;
  modname: string;
  name: string;
  url: string | null;
  /** HTML of the description shown on the course page (label text, "display description"), '' when none. */
  description: string;
  dates: PageDate[];
  tracking: Tracking;
  /** Complete as the page shows it (manual: marked done; automatic: every condition met). */
  done: boolean;
}

export interface CoursePage {
  /** Section summary HTML by section id. */
  summaries: Map<number, string>;
  cms: Map<number, PageCm>;
}

type DateRule = readonly [RegExp, (modname: string) => string];

/**
 * Activity-date labels (ja / en, as mod_*\dates print them) → the `dataid` the web service gives. 評定期限 before 期限.
 * Forum prints its due date as 終了日時 in Japanese; forums have no close date.
 */
const DATE_RULES: readonly DateRule[] = [
  [/^(?:評定期限|remind me to grade)/i, () => 'gradingduedate'],
  [/^(?:期限|due)/i, () => 'duedate'],
  [/^(?:締切|遮断|cut-?off)/i, () => 'cutoffdate'],
  [/^(?:開始|open)/i, (m) => (m === 'assign' ? 'allowsubmissionsfromdate' : 'timeopen')],
  [/^(?:終了|clos)/i, (m) => (m === 'forum' || m === 'hsuforum' ? 'duedate' : 'timeclose')],
];

function dataidOf(label: string, modname: string): string | null {
  const rule = DATE_RULES.find(([re]) => re.test(label));
  return rule ? rule[1](modname) : null;
}

/** `<div><strong>期限:</strong> 2026年 10月 8日(木曜日) 23:59</div>` lines of `[data-region="activity-dates"]`. */
function readDates(own: string, modname: string): PageDate[] {
  const region = findFirst(own, { attr: 'data-region', value: 'activity-dates' });
  if (!region) return [];
  const out: PageDate[] = [];
  for (const part of region.inner.split(/<strong(?![a-z])[^>]*>/i).slice(1)) {
    const close = part.search(/<\/strong>/i);
    if (close < 0) continue;
    const label = text(part.slice(0, close));
    const timestamp = parseMoodleDate(text(part.slice(close)));
    if (label && timestamp !== null) out.push({ label, timestamp, dataid: dataidOf(label, modname) });
  }
  return out;
}

/** Manual toggle (`data-toggletype="manual:mark-done|manual:undo"`) or automatic conditions (completion dropdown). */
function readCompletion(own: string): { tracking: Tracking; done: boolean } {
  const info = findFirst(own, { attr: 'data-region', value: 'completion-info' });
  if (!info) return { tracking: 0, done: false };
  const toggle = findFirst(info.inner, { attr: 'data-toggletype' });
  if (toggle) return { tracking: 1, done: attr(toggle.attrs, 'data-toggletype') === 'manual:undo' };
  if (!findFirst(info.inner, { attr: 'data-region', value: 'completionrequirements' })) {
    return { tracking: 0, done: false };
  }
  // The dropdown button turns btn-subtle-success when every condition is met (todo: btn-subtle-body).
  const button = findFirst(info.inner, { attr: 'data-for', value: 'dropdowndialog_button' });
  return { tracking: 2, done: button !== null && attr(button.attrs, 'class').includes('btn-subtle-success') };
}

/** The item up to its first nested cm item or section (a subsection holds its delegated section). */
function ownPart(el: HtmlElement): string {
  const from = el.outer.indexOf('>') + 1;
  const cuts = ['data-for="cmitem"', 'data-for="section"']
    .map((marker) => el.outer.indexOf(marker, from))
    .filter((i) => i >= 0);
  return cuts.length > 0 ? el.outer.slice(0, Math.min(...cuts)) : el.outer;
}

function readCm(el: HtmlElement): PageCm | null {
  const id = Number(attr(el.attrs, 'data-id'));
  const modname = /(?:^|\s)modtype_([a-z0-9_]+)/.exec(attr(el.attrs, 'class'))?.[1] ?? '';
  if (!Number.isSafeInteger(id) || id <= 0 || !modname) return null;
  const own = ownPart(el);
  const named = findFirst(own, { attr: 'data-activityname' });
  const nested = modname === 'subsection';
  const alt = nested ? null : findFirst(own, { attr: 'class', value: 'activity-altcontent', word: true });
  return {
    id,
    modname,
    name: named ? attr(named.attrs, 'data-activityname') : '',
    url: links(own).find((href) => href.includes(`/mod/${modname}/view.php`)) ?? null,
    description: alt ? alt.inner.trim() : '',
    dates: readDates(own, modname),
    ...readCompletion(own),
  };
}

/** The summary of a section container: the part before its module list (`.summary`, or `.summarytext` in 4.4+). */
function readSummary(el: HtmlElement): string {
  const listAt = el.outer.indexOf('data-for="cmlist"');
  const head = listAt < 0 ? el.outer : el.outer.slice(0, listAt);
  const box =
    findFirst(head, { attr: 'class', value: 'summarytext', word: true }) ??
    findFirst(head, { attr: 'class', value: 'summary', word: true });
  return box ? box.inner.trim() : '';
}

/** Sections and modules of a course page in one pass. */
export function parseCoursePage(html: string): CoursePage {
  const page: CoursePage = { summaries: new Map(), cms: new Map() };
  for (const el of findAll(html, { attr: 'data-for' })) {
    const kind = attr(el.attrs, 'data-for');
    if (kind === 'cmitem') {
      const cm = readCm(el);
      if (cm && !page.cms.has(cm.id)) page.cms.set(cm.id, cm);
    } else if (kind === 'section') {
      const id = Number(attr(el.attrs, 'data-id'));
      if (Number.isSafeInteger(id) && id > 0 && !page.summaries.has(id)) page.summaries.set(id, readSummary(el));
    }
  }
  return page;
}

/** The cm item of a `core_course_get_module` answer (the same markup as on the course page), or null. */
export function parseCmItem(snippet: string): PageCm | null {
  const el = findFirst(snippet, { attr: 'data-for', value: 'cmitem' });
  return el ? readCm(el) : null;
}
