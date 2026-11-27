/**
 * Open LMS Advanced Forum (mod_hsuforum) pages, read-only. index.php?id=<course> lists the course's forums
 * (`view.php?f=<forum id>` links, description, discussion and unread counts; no cmids, no forum type). view.php lists
 * discussions as `<article data-discussionid data-postid data-author>` threads (title `#thread-title-<discussion>`),
 * discuss.php renders posts as elements with `data-postid` / `data-author`, replies nested inside their parent.
 */

import { attr, findAll, findFirst, type HtmlElement, links, queryInt, text } from '../html';
import { timesIn } from './forum-time';

export interface HsuIndexForum {
  forumId: number;
  name: string;
  intro: string;
  numDiscussions: number | null;
  unread: number | null;
}

interface HsuDiscussion {
  discussion: number;
  firstPostId: number | null;
  subject: string;
  author: string | null;
  created: number | null;
}

interface HsuPost {
  id: number;
  parent: number;
  subject: string;
  message: string;
  author: string | null;
  created: number | null;
  canReply: boolean;
}

const intOf = (s: string): number | null => {
  const m = /^\s*(\d+)\s*$/.exec(text(s));
  return m ? Number(m[1]) : null;
};

const positive = (s: string): number | null => {
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function cells(tr: string): HtmlElement[] {
  return findAll(tr, { attr: 'class', tag: 'td' }).filter((td) => /(?:^|\s)cell(?:\s|$)/.test(attr(td.attrs, 'class')));
}

export function parseHsuIndex(html: string): HsuIndexForum[] {
  const out: HsuIndexForum[] = [];
  for (const tr of findAll(html, { attr: 'class', tag: 'tr' })) {
    const tds = cells(tr.inner);
    const link = tds[0] ? findFirst(tds[0].inner, { attr: 'href', tag: 'a' }) : null;
    const forumId = link ? queryInt(attr(link.attrs, 'href'), 'f') : null;
    if (!link || forumId === null || !attr(link.attrs, 'href').includes('view.php')) continue;
    const description = tds[1] ? findFirst(tds[1].inner, { attr: 'class', value: 'no-overflow', word: true }) : null;
    const intro = description?.inner ?? '';
    out.push({
      forumId,
      name: text(link.inner),
      intro: intro.trim(),
      numDiscussions: tds[2] ? intOf(tds[2].inner) : null,
      unread: tds[3] ? intOf(tds[3].inner) : null,
    });
  }
  return out;
}

/** The forum id a hsuforum page links to (`post.php?forum=`, `subscribe.php?id=`, `view.php?f=`), or null. */
export function hsuForumIdOf(html: string): number | null {
  for (const href of links(html)) {
    if (!href.includes('/mod/hsuforum/')) continue;
    const id =
      (href.includes('post.php') && queryInt(href, 'forum')) ||
      (href.includes('subscribe.php') && queryInt(href, 'id')) ||
      (href.includes('view.php') && queryInt(href, 'f'));
    if (id) return id;
  }
  const input = findFirst(html, { attr: 'name', value: 'forum', tag: 'input' });
  return input ? positive(attr(input.attrs, 'value')) : null;
}

export function parseHsuDiscussions(html: string): HsuDiscussion[] {
  const seen = new Set<number>();
  const out: HsuDiscussion[] = [];
  for (const el of findAll(html, { attr: 'data-discussionid' })) {
    const discussion = positive(attr(el.attrs, 'data-discussionid'));
    if (discussion === null || seen.has(discussion) || el.tag === 'input') continue;
    seen.add(discussion);
    const title = findFirst(el.inner, { attr: 'id', value: `thread-title-${discussion}` });
    const link = findAll(el.inner, { attr: 'href', tag: 'a' }).find((a) =>
      attr(a.attrs, 'href').includes('discuss.php'),
    );
    out.push({
      discussion,
      firstPostId: positive(attr(el.attrs, 'data-postid')),
      subject: text((title ?? link)?.inner ?? ''),
      author: attr(el.attrs, 'data-author') || null,
      created: timesIn(el.inner)[0] ?? null,
    });
  }
  return out;
}

function subjectOf(el: HtmlElement): string {
  // The thread heading of a discussion's first post comes before its replies' titles.
  const title =
    findFirst(el.inner, { attr: 'role', value: 'heading' }) ??
    findFirst(el.inner, { attr: 'class', value: 'hsuforum-post-title', word: true });
  return title ? text(title.inner) : '';
}

/** The post id of the innermost earlier post element that contains element `i` (0 = none: the first post). */
function parentOf(els: HtmlElement[], i: number): number {
  const el = els[i];
  if (!el) return 0;
  const end = el.start + el.outer.length;
  for (let j = i - 1; j >= 0; j--) {
    const outer = els[j];
    if (outer && outer.start + outer.outer.length >= end) return positive(attr(outer.attrs, 'data-postid')) ?? 0;
  }
  return 0;
}

/** Posts of a discuss.php page in document order; the parent is the innermost post element around a post. */
export function parseHsuPosts(html: string): HsuPost[] {
  const els = findAll(html, { attr: 'data-postid' }).filter((el) => el.tag !== 'input' && el.tag !== 'a');
  const ids = new Set<number>();
  const out: HsuPost[] = [];
  els.forEach((el, i) => {
    const id = positive(attr(el.attrs, 'data-postid'));
    if (id === null || ids.has(id)) return;
    ids.add(id);
    const parent = parentOf(els, i);
    const posting = findFirst(el.inner, { attr: 'class', value: 'posting', word: true });
    out.push({
      id,
      parent: parent === id ? 0 : parent,
      subject: subjectOf(el),
      message: posting?.inner.trim() ?? '',
      author: attr(el.attrs, 'data-author') || null,
      created: timesIn(el.inner)[0] ?? null,
      canReply: links(el.outer).some((h) => queryInt(h, 'reply') === id),
    });
  });
  return out;
}
