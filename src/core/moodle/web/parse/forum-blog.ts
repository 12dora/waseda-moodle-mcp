/**
 * The discussion list of a blog-like forum (body class `forumtype-blog`): Moodle shows each discussion as its first
 * post (`<article data-region="post" data-post-id>`: subject, author, `<time datetime>`, body) followed by a
 * "Discuss this topic" link to `discuss.php?d=<id>` and the reply count, instead of the discussion table.
 */

import { attr, findAll, findFirst, links, queryInt, text } from '../html';
import { timesIn } from './forum-time';
import type { DiscussionRow } from './forum-view';

/** `(現在の返信数: 3)` / `(3 replies so far)` after the discuss link. */
const REPLIES = /\(\s*(?:[^():\d]*[:：]\s*)?(\d+)(?:\s*[a-z ]*)?\)/i;

function discussionOf(article: string): number | null {
  for (const href of links(article)) {
    if (href.includes('/mod/forum/discuss.php')) return queryInt(href, 'd');
  }
  return null;
}

/** The post's own permalink (`discuss.php?d=<id>#p<postId>`): a link in the post body may name another discussion. */
function permalinkDiscussion(article: string, postId: number): number | null {
  const own = links(article).find((h) => h.includes('/mod/forum/discuss.php') && h.endsWith(`#p${postId}`));
  return own ? queryInt(own, 'd') : null;
}

function blogRow(article: { attrs: string; outer: string }, tail: string): DiscussionRow | null {
  const postId = Number(attr(article.attrs, 'data-post-id'));
  if (!Number.isSafeInteger(postId) || postId <= 0) return null;
  // the "discuss this topic" box right after the article holds the discussion link and the reply count
  const box = findFirst(tail, { attr: 'class', value: 'link', word: true })?.outer ?? '';
  const discussion = permalinkDiscussion(article.outer, postId) ?? discussionOf(box);
  if (!discussion) return null;
  const subject = findFirst(article.outer, { attr: 'data-region-content', value: 'forum-post-core-subject' });
  const header = findFirst(article.outer, { attr: 'class', value: 'header', word: true, tag: 'header' })?.inner ?? '';
  const profile = findAll(header, { attr: 'href', tag: 'a' }).find((a) =>
    /\/user\/(?:view|profile)\.php\?/.test(attr(a.attrs, 'href')),
  );
  const replies = REPLIES.exec(text(box));
  const created = timesIn(header)[0] ?? null;
  return {
    discussion,
    subject: subject ? text(subject.inner) : '',
    author: profile ? text(profile.inner) || null : null,
    authorId: profile ? queryInt(attr(profile.attrs, 'href'), 'id') : null,
    created,
    modified: created,
    replies: replies ? Number(replies[1]) : null,
    unread: null,
    pinned: false,
    latestPostId: replies && Number(replies[1]) === 0 ? postId : null,
  };
}

/** One row per top-level post article; `tail` = the markup up to the next article (discuss link, reply count). */
export function parseBlogRows(html: string): DiscussionRow[] {
  const articles = findAll(html, { attr: 'data-region', value: 'post', tag: 'article' });
  const rows: DiscussionRow[] = [];
  articles.forEach((a, i) => {
    const end = articles[i + 1]?.start ?? html.length;
    const row = blogRow(a, html.slice(a.start + a.outer.length, Math.min(end, a.start + a.outer.length + 2000)));
    if (row && !rows.some((r) => r.discussion === row.discussion)) rows.push(row);
  });
  return rows;
}
