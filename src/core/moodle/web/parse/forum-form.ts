/**
 * mod/forum/post.php pages: the post form (`post.php?forum=` new discussion, `?edit=` own post, `?reply=` reply; one
 * `mod_forum_post_form` with hidden course/forum/discussion/parent ids), its attachment filemanager options, the post
 * rendered above a reply form and the delete confirmation.
 */

import {
  attr,
  type FormFields,
  findAll,
  findFirst,
  formFields,
  type HtmlElement,
  links,
  queryInt,
  text,
} from '../html';
import { timesIn } from './forum-time';

export interface PostForm {
  /** The form's `action` path ('/mod/forum/post.php'). */
  action: string;
  fields: FormFields;
  /** Selected options of the multi-select tag field (formFields keeps one value per name). */
  tags: string[];
  /** Value of the submit button (`submitbutton`), sent like a browser does. */
  submit: string | null;
  attachments: FileManager | null;
}

export interface DraftFile {
  filename: string;
  filesize: number | null;
  url: string | null;
  mimetype: string | null;
}

interface FileManager {
  itemId: number | null;
  maxFiles: number | null;
  maxBytes: number | null;
  files: DraftFile[];
}

const FORM_MARKER = '_qf__mod_forum_post_form';
const FM_INIT = 'M.form_filemanager.init(Y, ';

/** End offset (exclusive) of the JSON object literal starting at `start` (string-aware brace matching), or -1. */
function objectEnd(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      i = stringEnd(src, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Offset of the closing quote of the JSON string opened at `open`. */
function stringEnd(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '"') return i;
  }
  return src.length;
}

/** The JSON object literal starting at `start`, parsed (linear); null when there is none or it is invalid. */
function jsonObjectAt(src: string, start: number): unknown {
  const end = src[start] === '{' ? objectEnd(src, start) : -1;
  if (end < 0) return null;
  try {
    return JSON.parse(src.slice(start, end));
  } catch {
    return null;
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function toNum(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function draftFile(v: unknown): DraftFile | null {
  if (!isRec(v) || typeof v.filename !== 'string' || v.type === 'folder') return null;
  return {
    filename: v.filename,
    filesize: toNum(v.filesize ?? v.size),
    url: typeof v.url === 'string' ? v.url : null,
    mimetype: typeof v.mimetype === 'string' ? v.mimetype : null,
  };
}

/** Options of the filemanager bound to the `attachments` field (maxfiles, maxbytes, current draft files). */
function attachmentManager(html: string): FileManager | null {
  for (let at = html.indexOf(FM_INIT); at >= 0; at = html.indexOf(FM_INIT, at + 1)) {
    const opts = jsonObjectAt(html, at + FM_INIT.length);
    if (!isRec(opts) || opts.target !== 'id_attachments') continue;
    const list = Array.isArray(opts.list) ? opts.list : [];
    return {
      itemId: toNum(opts.itemid),
      maxFiles: toNum(opts.maxfiles),
      maxBytes: toNum(opts.maxbytes),
      files: list.map(draftFile).filter((f): f is DraftFile => f !== null),
    };
  }
  return null;
}

function selectedTags(form: string): string[] {
  const select = findFirst(form, { attr: 'name', value: 'tags[]', tag: 'select' });
  if (!select) return [];
  return findAll(select.inner, { attr: 'value', tag: 'option' })
    .filter((o) => /(?:^|\s)selected(?:\s|=|$)/i.test(o.attrs))
    .map((o) => attr(o.attrs, 'value'));
}

/**
 * A URL of mod/forum/post.php: Moodle renders the post form's action relative (`action="post.php"`), single buttons
 * and links absolute (`https://…/mod/forum/post.php?…`). Not mod/hsuforum/post.php.
 */
const isPostPhp = (url: string) => /^(?:post\.php|[^?#]*\/mod\/forum\/post\.php)(?:[?#]|$)/.test(url);

function postFormElement(html: string): HtmlElement | null {
  return (
    findAll(html, { attr: 'action', tag: 'form' }).find(
      (f) => isPostPhp(attr(f.attrs, 'action')) && f.inner.includes(FORM_MARKER),
    ) ?? null
  );
}

/** The forum post form of a post.php page, or null when the page has none. */
export function parsePostForm(html: string): PostForm | null {
  const form = postFormElement(html);
  if (!form) return null;
  const fields = formFields(form.outer);
  fields.delete('tags[]');
  const submit = findFirst(form.inner, { attr: 'name', value: 'submitbutton', tag: 'input' });
  return {
    action: '/mod/forum/post.php',
    fields,
    tags: selectedTags(form.inner),
    submit: submit ? attr(submit.attrs, 'value') : null,
    attachments: attachmentManager(html),
  };
}

export const fieldInt = (form: PostForm, name: string): number | null => {
  const n = Number(form.fields.get(name));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** The URL-encoded body of a form submission: its fields, the tags and the submit button. */
export function formBody(form: PostForm): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of form.fields) body.append(k, v);
  for (const t of form.tags) body.append('tags[]', t);
  if (form.submit !== null) body.set('submitbutton', form.submit);
  return body;
}

export interface RenderedPost {
  id: number;
  subject: string | null;
  message: string;
  author: string | null;
  authorId: number | null;
  created: number | null;
}

/** The post Moodle renders above a reply form (`<article data-post-id>`, mod_forum/forum_discussion_post). */
export function renderedPost(html: string, postId: number): RenderedPost | null {
  const article = findFirst(html, { attr: 'data-post-id', value: String(postId) });
  if (!article) return null;
  const subject = findFirst(article.inner, { attr: 'data-region-content', value: 'forum-post-core-subject' });
  const content = findFirst(article.inner, { attr: 'class', value: 'post-content-container', word: true });
  const header = /<header\b[\s\S]*?<\/header>/i.exec(article.inner)?.[0] ?? article.inner;
  const profile = findAll(header, { attr: 'href', tag: 'a' }).find((a) =>
    /\/user\/(view|profile)\.php\?/.test(attr(a.attrs, 'href')),
  );
  return {
    id: postId,
    subject: subject ? text(subject.inner) || null : null,
    message: content?.inner.trim() ?? '',
    author: profile ? text(profile.inner) || null : null,
    authorId: profile ? queryInt(attr(profile.attrs, 'href'), 'id') : null,
    created: timesIn(article.inner)[0] ?? null,
  };
}

interface ConfirmForm {
  action: string;
  fields: FormFields;
}

/** post.php with the query of `url` (absolute or relative), as a session path. */
const postPath = (url: string) => {
  const query = url.split('?')[1];
  return query ? `/mod/forum/post.php?${query}` : '/mod/forum/post.php';
};

/** The "continue" form of a delete confirmation (`delete=<id>&confirm=<id>&sesskey`), or null. */
export function deleteConfirm(html: string, postId: number): ConfirmForm | null {
  for (const form of findAll(html, { attr: 'action', tag: 'form' })) {
    const action = attr(form.attrs, 'action');
    if (!isPostPhp(action)) continue;
    const fields = formFields(form.outer);
    const inQuery = queryInt(action, 'confirm');
    if (fields.get('confirm') === String(postId) || inQuery === postId) return { action: postPath(action), fields };
  }
  const link = links(html).find((h) => isPostPhp(h) && queryInt(h, 'confirm') === postId);
  return link ? { action: postPath(link), fields: new Map() } : null;
}
