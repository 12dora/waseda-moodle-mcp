/**
 * Minimal, linear-time HTML helpers for Moodle pages (no DOM: Workers CPU). Elements are located by an attribute
 * (`data-region="activity-dates"`, `id="region-main"`, `class~="activity"`) and cut out with tag balancing.
 * Every adapter of the web channel uses these instead of its own regexes.
 */

import { decodeEntities, htmlToText, tagAttr } from '../../html';

export interface HtmlElement {
  /** Lower-case tag name. */
  readonly tag: string;
  /** The raw attribute string of the start tag. */
  readonly attrs: string;
  /** Start tag through end tag. */
  readonly outer: string;
  /** Between start and end tag ('' for void elements). */
  readonly inner: string;
  /** Offset of the start tag in the searched string. */
  readonly start: number;
}

export interface ElementQuery {
  /** Attribute that must be present, e.g. 'data-region' or 'id'. */
  attr: string;
  /** Exact value of `attr` (entities decoded). Omit to accept any value. */
  value?: string;
  /** `attr` is a space-separated list (class) that must contain `value`. */
  word?: boolean;
  /** Only this tag name. */
  tag?: string;
}

const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Attribute text may hold `>` inside quotes; the alternatives are disjoint, so matching stays linear. */
const ATTRS = `((?:[^<>"']|"[^"]*"|'[^']*')*)`;
const START_TAG = new RegExp(`<([a-zA-Z][a-zA-Z0-9:-]*)(?![a-zA-Z0-9:-])${ATTRS}>`, 'g');
const ESC = /[.*+?^${}()|[\]\\]/g;

/** Value of one attribute of a start tag's attribute string ('' when absent). */
export const attr = (attrs: string, name: string): string => tagAttr(attrs, name);

/** Plain text of an HTML fragment (entities decoded, whitespace collapsed). */
export const text = (html: string): string => htmlToText(html).replace(/\s+/g, ' ').trim();

function matches(q: ElementQuery, tag: string, attrs: string): boolean {
  if (q.tag && q.tag !== tag) return false;
  if (!new RegExp(`(?:^|\\s)${q.attr.replace(ESC, '\\$&')}\\s*=`, 'i').test(attrs)) return false;
  if (q.value === undefined) return true;
  const v = tagAttr(attrs, q.attr);
  return q.word ? v.split(/\s+/).includes(q.value) : v === q.value;
}

/** End offset (exclusive) of the element whose start tag ends at `from`; balanced on the same tag name. */
function closeOf(html: string, tag: string, from: number): number {
  const re = new RegExp(`<(/?)${tag.replace(ESC, '\\$&')}(?![a-zA-Z0-9:-])${ATTRS}>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) depth--;
    else if (!m[0].endsWith('/>')) depth++;
    if (depth === 0) return m.index + m[0].length;
  }
  return html.length; // unclosed: runs to the end
}

function elementAt(html: string, m: RegExpExecArray): HtmlElement {
  const tag = (m[1] ?? '').toLowerCase();
  const attrs = m[2] ?? '';
  const startEnd = m.index + m[0].length;
  if (VOID.has(tag) || m[0].endsWith('/>')) {
    return { tag, attrs, outer: m[0], inner: '', start: m.index };
  }
  const end = closeOf(html, tag, startEnd);
  const closeTag = html.lastIndexOf('<', end - 1);
  const innerEnd = closeTag >= startEnd ? closeTag : end;
  return { tag, attrs, outer: html.slice(m.index, end), inner: html.slice(startEnd, innerEnd), start: m.index };
}

/** All elements matching `q`, in document order. Nested matches are returned too (each with its own subtree). */
export function findAll(html: string, q: ElementQuery): HtmlElement[] {
  const out: HtmlElement[] = [];
  START_TAG.lastIndex = 0;
  for (let m = START_TAG.exec(html); m; m = START_TAG.exec(html)) {
    const tag = (m[1] ?? '').toLowerCase();
    if (matches(q, tag, m[2] ?? '')) out.push(elementAt(html, m));
  }
  return out;
}

/** The first element matching `q`, or null. */
export function findFirst(html: string, q: ElementQuery): HtmlElement | null {
  START_TAG.lastIndex = 0;
  for (let m = START_TAG.exec(html); m; m = START_TAG.exec(html)) {
    const tag = (m[1] ?? '').toLowerCase();
    if (matches(q, tag, m[2] ?? '')) return elementAt(html, m);
  }
  return null;
}

/** The page's main region (`#region-main`), or the whole page when it has none. */
export function mainRegion(html: string): string {
  return findFirst(html, { attr: 'id', value: 'region-main' })?.inner ?? html;
}

/** Every `href` of `<a>` tags in `html`, entities decoded, in document order. */
export function links(html: string): string[] {
  return findAll(html, { attr: 'href', tag: 'a' }).map((a) => attr(a.attrs, 'href'));
}

/** The numeric query parameter `name` of a URL (absolute or relative), or null. */
export function queryInt(url: string, name: string): number | null {
  const m = new RegExp(`[?&]${name.replace(ESC, '\\$&')}=(\\d+)`).exec(decodeEntities(url));
  const n = m ? Number(m[1]) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type FormFields = Map<string, string>;

function fieldValue(el: HtmlElement): string | null {
  if (el.tag === 'textarea') return decodeEntities(el.inner);
  if (el.tag === 'select') {
    const options = findAll(el.inner, { attr: 'value', tag: 'option' });
    const chosen = options.find((o) => /(?:^|\s)selected(?:\s|=|$)/i.test(o.attrs)) ?? options[0];
    return chosen ? attr(chosen.attrs, 'value') : null;
  }
  const type = attr(el.attrs, 'type').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    return /(?:^|\s)checked(?:\s|=|$)/i.test(el.attrs) ? attr(el.attrs, 'value') || '1' : null;
  }
  if (type === 'submit' || type === 'button' || type === 'file' || type === 'image') return null;
  return attr(el.attrs, 'value');
}

/**
 * The values a browser would submit for a form's fields as they are on the page: hidden/text inputs, checked
 * checkboxes and radios, the selected option, textarea contents; disabled controls are skipped and a later control
 * of the same name replaces an earlier one (PHP keeps the last). Buttons are left out (add the one you press).
 */
export function formFields(formHtml: string): FormFields {
  const out: FormFields = new Map();
  for (const el of findAll(formHtml, { attr: 'name' })) {
    if (el.tag !== 'input' && el.tag !== 'select' && el.tag !== 'textarea') continue;
    const name = attr(el.attrs, 'name');
    const value = /(?:^|\s)disabled(?:\s|=|$)/i.test(el.attrs) ? null : fieldValue(el);
    // the last control of a name wins, as in PHP's $_POST (advcheckbox: hidden "0", then the checkbox "1")
    if (name && value !== null) out.set(name, value);
  }
  return out;
}

/** The first `<form>` whose action contains `actionPart` (e.g. '/mod/assign/view.php'), or null. */
export function findForm(html: string, actionPart: string): HtmlElement | null {
  return (
    findAll(html, { attr: 'action', tag: 'form' }).find((f) => attr(f.attrs, 'action').includes(actionPart)) ?? null
  );
}

export interface PageConfig {
  sesskey: string | null;
  userId: number | null;
  courseId: number | null;
  /** The page context's instance id: the cmid on an activity page, the course id on a course page. */
  contextInstanceId: number | null;
  contextId: number | null;
  /** The course's context id (fragments such as the activity overview take it). */
  courseContextId: number | null;
  /** `<html lang>`: the session's interface language (ja, en, zh_cn, …). */
  lang: string | null;
}

const cfgString = (html: string, key: string): string | null =>
  new RegExp(`"${key}":"([^"\\\\]*)"`).exec(html)?.[1] ?? null;
const cfgInt = (html: string, key: string): number | null => {
  const n = Number(new RegExp(`"${key}":(\\d+)`).exec(html)?.[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** The `M.cfg = {…};` object literal of a page ('' when absent). */
function cfgBlock(html: string): string {
  const at = html.indexOf('M.cfg = {');
  if (at < 0) return '';
  const end = html.indexOf('};', at);
  return html.slice(at, end < 0 ? undefined : end + 1);
}

/** The `M.cfg` values every Moodle page carries. */
export function pageConfig(html: string): PageConfig {
  const cfg = cfgBlock(html);
  const lang = /<html[^>]*\slang="([^"]+)"/i.exec(html)?.[1] ?? null;
  return {
    sesskey: cfgString(cfg, 'sesskey'),
    userId: cfgInt(cfg, 'userId'),
    courseId: cfgInt(cfg, 'courseId'),
    contextInstanceId: cfgInt(cfg, 'contextInstanceId'),
    contextId: cfgInt(cfg, 'contextid'),
    courseContextId: cfgInt(cfg, 'courseContextId'),
    lang: lang ? lang.replace('-', '_').toLowerCase() : null,
  };
}
