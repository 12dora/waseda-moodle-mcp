/**
 * The user's own forum posts page (`/mod/forum/user.php?id=<user>[&course=<id>][&page=N]`): one `<article
 * data-region="post">` per post whose heading reads `course -> forum -> discussion [-> parent post]`. A post with a
 * parent link (`discuss.php?d=<id>#p<parent>`) is a reply; the page prints no reply counts and no unread state.
 * Everything is read from ids in links and the `<time datetime>` value, not from the interface language.
 */

import { attr, findAll, findFirst, type HtmlElement, text } from '../../moodle/web/html';
import { isoJst } from '../../time';
import type { MyPost } from './types';

interface PostsPage {
  posts: MyPost[];
  /** Page numbers (0-based `page=`) the pager links to. */
  linkedPages: number[];
  /** Posts per page as the pager states it. */
  pageSize: number | null;
}

const EXCERPT_CHARS = 200;
const COURSE_LINK = /\/course\/view\.php\?id=(\d+)/;
const FORUM_LINK = /\/mod\/(forum|hsuforum)\/view\.php\?id=(\d+)/;
const DISCUSSION_LINK = /\/mod\/(?:forum|hsuforum)\/discuss\.php\?d=(\d+)(?:#p(\d+))?$/;
const PAGE_PARAM = /[?&]page=(\d+)/;

interface HeadingLinks {
  courseId: number | null;
  courseName: string;
  forumType: 'forum' | 'hsuforum';
  forumCmid: number | null;
  forumName: string;
  discussionId: number | null;
  discussionSubject: string;
  discussionHref: string;
  parentPostId: number | null;
}

const toId = (s: string | undefined): number | null => {
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** The heading's links: course, forum, discussion and (replies) the parent post. */
function headingLinks(heading: HtmlElement): HeadingLinks {
  const out: HeadingLinks = {
    courseId: null,
    courseName: '',
    forumType: 'forum',
    forumCmid: null,
    forumName: '',
    discussionId: null,
    discussionSubject: '',
    discussionHref: '',
    parentPostId: null,
  };
  for (const a of findAll(heading.inner, { attr: 'href', tag: 'a' })) {
    const href = attr(a.attrs, 'href');
    const label = text(a.inner);
    const course = COURSE_LINK.exec(href);
    const forum = FORUM_LINK.exec(href);
    const discussion = DISCUSSION_LINK.exec(href);
    if (course) {
      out.courseId = toId(course[1]);
      out.courseName = label;
    } else if (forum) {
      out.forumType = forum[1] === 'hsuforum' ? 'hsuforum' : 'forum';
      out.forumCmid = toId(forum[2]);
      out.forumName = label;
    } else if (discussion?.[2]) {
      out.parentPostId = toId(discussion[2]);
    } else if (discussion && out.discussionId === null) {
      out.discussionId = toId(discussion[1]);
      out.discussionSubject = label;
      out.discussionHref = href;
    }
  }
  return out;
}

/** The post's own subject: the box label "<subject> by <author>" without the author, else the reply subject. */
function ownSubject(post: string, heading: HtmlElement): string {
  const box = findFirst(post, { attr: 'data-content', value: 'forum-post' });
  const label = box ? attr(box.attrs, 'aria-label') : '';
  const authorLink = findAll(post, { attr: 'href', tag: 'a' }).find((a) =>
    attr(a.attrs, 'href').includes('/user/view'),
  );
  const author = authorLink ? text(authorLink.inner) : '';
  if (label && author && label.endsWith(author)) {
    const subject = label.slice(0, label.length - author.length).replace(/\s+by\s*$/i, '');
    if (subject.trim()) return subject.trim();
  }
  return attr(heading.attrs, 'data-reply-subject') || label;
}

const postedAt = (post: string): string | null => {
  const time = findFirst(post, { attr: 'datetime', tag: 'time' });
  const ms = time ? Date.parse(attr(time.attrs, 'datetime')) : Number.NaN;
  return Number.isNaN(ms) ? null : isoJst(ms);
};

function excerptOf(post: string): string {
  const body = findFirst(post, { attr: 'class', value: 'post-content-container', word: true });
  return body ? [...text(body.inner)].slice(0, EXCERPT_CHARS).join('') : '';
}

function readPost(el: HtmlElement): MyPost | null {
  const postId = toId(attr(el.attrs, 'data-post-id'));
  const heading = findFirst(el.outer, { attr: 'data-region-content', value: 'forum-post-core-subject' });
  if (postId === null || !heading) return null;
  const links = headingLinks(heading);
  if (links.discussionId === null) return null;
  const isDiscussionStart = links.parentPostId === null;
  return {
    postId,
    discussionId: links.discussionId,
    courseId: links.courseId,
    courseName: links.courseName,
    forumType: links.forumType,
    forumCmid: links.forumCmid,
    forumName: links.forumName,
    discussionSubject: links.discussionSubject,
    postSubject: isDiscussionStart ? links.discussionSubject : ownSubject(el.outer, heading),
    postedAt: postedAt(el.outer),
    isDiscussionStart,
    parentPostId: links.parentPostId,
    replies: null,
    excerpt: excerptOf(el.outer),
    url: `${links.discussionHref}#p${postId}`,
  };
}

/** Posts and pager of one page; a page without posts (none written, or not a posts page) gives empty lists. */
export function parsePostsPage(html: string): PostsPage {
  const articles = findAll(html, { attr: 'data-region', value: 'post', tag: 'article' });
  const posts = articles.flatMap((el) => readPost(el) ?? []);
  const pager = findFirst(html, { attr: 'data-page-size', tag: 'ul' });
  const size = pager ? Number(attr(pager.attrs, 'data-page-size')) : Number.NaN;
  const linkedPages = pager
    ? findAll(pager.inner, { attr: 'href', tag: 'a' }).flatMap((a) => {
        const m = PAGE_PARAM.exec(attr(a.attrs, 'href'));
        return m ? [Number(m[1])] : [];
      })
    : [];
  return { posts, linkedPages, pageSize: Number.isSafeInteger(size) && size > 0 ? size : null };
}
