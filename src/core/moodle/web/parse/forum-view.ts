/**
 * The mod/forum view page (`/mod/forum/view.php?id=<cmid>` or `?f=<forum id>`): forum identity and settings the page
 * shows, plus its discussion list (`<tr data-region="discussion-list-item" data-discussionid>` rows, Moodle 4/5
 * mod_forum/discussion_list template). The forum id is on the inline add-discussion form (hidden `forum`), the
 * "add discussion" / subscribe links or the rows; an empty announcements forum shows none of them.
 */

import { attr, findAll, findFirst, findForm, formFields, links, pageConfig, queryInt, text } from '../html';
import { textSeconds, timesIn } from './forum-time';

export interface DiscussionRow {
  discussion: number;
  subject: string;
  author: string | null;
  authorId: number | null;
  created: number | null;
  /** Time of the latest post. */
  modified: number | null;
  replies: number | null;
  unread: number | null;
  pinned: boolean;
  /** Id of the latest post (= the first post when there are no replies). */
  latestPostId: number | null;
}

export interface ForumView {
  cmid: number | null;
  courseId: number | null;
  forumId: number | null;
  /** Moodle forum type from the body class `forumtype-<type>` (news, general, qanda, blog, eachuser, single). */
  type: string | null;
  name: string | null;
  /** Description HTML ('' when none). */
  intro: string;
  dueDate: number | null;
  /** The page offers "add discussion" (inline form or link). */
  canCreate: boolean;
  /** A subscribe / unsubscribe button: the user may choose (forcesubscribe optional or auto). */
  subscriptionChoice: boolean;
  rows: DiscussionRow[];
  /** Moodle shows a link to the next page of discussions. */
  hasNextPage: boolean;
}

/** The forum due date label: ja mod_forum prints `終了日時:` (some sites `期限:`), en `Due:`. */
const DUE_LABEL = /^(?:終了日時|期限|due)/i;

function bodyClasses(html: string): string[] {
  const body = /<body\b[^>]*>/i.exec(html)?.[0] ?? '';
  return attr(body, 'class').split(/\s+/);
}

function forumType(html: string): string | null {
  const cls = bodyClasses(html).find((c) => c.startsWith('forumtype-'));
  return cls ? cls.slice('forumtype-'.length) || null : null;
}

/** The activity dates block; forum pages only print the due date (`終了日時:` / `Due:`). */
function dueDateOf(html: string): number | null {
  const region = findFirst(html, { attr: 'data-region', value: 'activity-dates' });
  if (!region) return null;
  for (const line of region.inner.split(/<\/div>/i)) {
    const t = text(line);
    if (DUE_LABEL.test(t)) return textSeconds(t);
  }
  return null;
}

function introOf(html: string): string {
  const intro = findFirst(html, { attr: 'id', value: 'intro' });
  if (!intro) return '';
  return (findFirst(intro.inner, { attr: 'class', value: 'no-overflow', word: true })?.inner ?? intro.inner).trim();
}

function numberIn(s: string): number | null {
  const m = /^\s*(\d+)\s*$/.exec(text(s));
  return m ? Number(m[1]) : null;
}

/** The reply count is the bare `<span>N</span>` of its cell; the unread badge links to `#unread`. */
function countsOf(row: string): { replies: number | null; unread: number | null } {
  const replies = /<span>\s*(\d+)\s*<\/span>/.exec(row);
  const badge = findAll(row, { attr: 'href', tag: 'a' }).find((a) => attr(a.attrs, 'href').includes('#unread'));
  return { replies: replies ? Number(replies[1]) : null, unread: badge ? numberIn(badge.inner) : null };
}

function authorOf(row: string): { author: string | null; authorId: number | null } {
  const cell = findFirst(row, { attr: 'class', value: 'author', word: true })?.inner ?? '';
  const name = findFirst(cell, { attr: 'class', value: 'text-truncate', word: true });
  const profile = links(cell).find((h) => /\/user\/(view|profile)\.php\?/.test(h));
  return {
    author: name ? text(name.inner) || null : null,
    authorId: profile ? queryInt(profile, 'id') : null,
  };
}

function subjectOf(row: string, discussion: number): string {
  const link = findAll(row, { attr: 'href', tag: 'a' }).find((a) => {
    const href = attr(a.attrs, 'href');
    return href.includes('discuss.php') && queryInt(href, 'd') === discussion && !/[#&]/.test(href.split('?')[1] ?? '');
  });
  if (!link) return '';
  return attr(link.attrs, 'title') || text(link.inner);
}

function latestPostOf(row: string): number | null {
  for (const href of links(row)) {
    const m = /#p(\d+)$/.exec(href);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Created = the first `<time>` of the row (author cell), latest post = the last one; tooltips as a fallback. */
function timesOf(row: string): { created: number | null; modified: number | null } {
  const times = timesIn(row);
  if (times.length > 1) return { created: times[0] ?? null, modified: times.at(-1) ?? null };
  if (times.length === 1) return { created: times[0] ?? null, modified: null };
  const titled = findAll(row, { attr: 'title', tag: 'a' })
    .map((a) => textSeconds(attr(a.attrs, 'title')))
    .filter((s): s is number => s !== null);
  return { created: null, modified: titled.at(-1) ?? null };
}

export function parseDiscussionRows(html: string): DiscussionRow[] {
  const out: DiscussionRow[] = [];
  for (const tr of findAll(html, { attr: 'data-discussionid', tag: 'tr' })) {
    const discussion = Number(attr(tr.attrs, 'data-discussionid'));
    if (!Number.isSafeInteger(discussion) || discussion <= 0) continue;
    out.push({
      discussion,
      subject: subjectOf(tr.outer, discussion),
      ...authorOf(tr.outer),
      ...timesOf(tr.outer),
      ...countsOf(tr.outer),
      pinned: attr(tr.attrs, 'class').split(/\s+/).includes('pinned'),
      latestPostId: latestPostOf(tr.outer),
    });
  }
  return out;
}

const positive = (v: string | undefined): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** `post.php?forum=<id>` (add discussion) or `subscribe.php?id=<id>` links carry the forum id. */
function forumIdInLinks(html: string): number | null {
  for (const href of links(html)) {
    const id =
      (href.includes('/mod/forum/post.php') && queryInt(href, 'forum')) ||
      (href.includes('/mod/forum/subscribe.php') && queryInt(href, 'id'));
    if (id) return id;
  }
  return null;
}

function forumIdOf(html: string): number | null {
  const form = findForm(html, '/mod/forum/post.php');
  const row = findFirst(html, { attr: 'data-forumid', tag: 'tr' });
  return (
    positive(form ? formFields(form.outer).get('forum') : undefined) ??
    forumIdInLinks(html) ??
    positive(row ? attr(row.attrs, 'data-forumid') : undefined)
  );
}

function nameOf(html: string): string | null {
  const list = findAll(html, { attr: 'data-name', tag: 'div' }).find((d) =>
    attr(d.attrs, 'id').startsWith('discussion-list'),
  );
  const info = findFirst(html, { attr: 'data-region', value: 'activity-information' });
  const name = (list && attr(list.attrs, 'data-name')) || (info && attr(info.attrs, 'data-activityname'));
  return name || null;
}

function canCreateOf(html: string): boolean {
  const form = findForm(html, '/mod/forum/post.php');
  if (form && formFields(form.outer).has('_qf__mod_forum_post_form')) return true;
  return links(html).some((h) => h.includes('/mod/forum/post.php') && queryInt(h, 'forum') !== null);
}

/** Moodle's paging bar links the next page as `view.php?…&p=<n>`. */
function hasNextPage(html: string, pageNo: number): boolean {
  return links(html).some((h) => h.includes('/mod/forum/view.php') && queryInt(h, 'p') === pageNo + 1);
}

export function parseForumView(html: string, pageNo = 0): ForumView {
  const cfg = pageConfig(html);
  return {
    cmid: cfg.contextInstanceId,
    courseId: cfg.courseId,
    forumId: forumIdOf(html),
    type: forumType(html),
    name: nameOf(html),
    intro: introOf(html),
    dueDate: dueDateOf(html),
    canCreate: canCreateOf(html),
    subscriptionChoice: links(html).some((h) => h.includes('/mod/forum/subscribe.php')),
    rows: parseDiscussionRows(html),
    hasNextPage: hasNextPage(html, pageNo),
  };
}
