/**
 * Moodle's own forum search (`/mod/forum/search.php?id=<course>&search=<words>&perpage=<n>&page=<p>`): full text over
 * every post of the course's mod_forum forums (subjects and messages, replies too), newest first; reading it marks
 * nothing read. Each result is an `<article data-region="post" data-post-id>`; its subject heading
 * (`data-region-content="forum-post-core-subject"`, the post's subject in `data-reply-subject`) links the forum
 * (`view.php?id=<cmid>`), the discussion (`discuss.php?d=<id>`) and, for a reply, its parent
 * (`discuss.php?d=<id>#p<parent>`).
 * The message (`#post-content-<post id>`) wraps the matched words in `<span class="highlight">`. Paging bar:
 * `<li class="page-item [active]" data-page-number="<1-based>">`. Nothing here depends on the interface language.
 */

import { MoodleError } from '../../../errors';
import { attr, findAll, findFirst, type HtmlElement, mainRegion, queryInt, text } from '../html';
import type { WebSession } from '../types';
import { timesIn } from './forum-time';

export interface SearchPost {
  postId: number;
  discussionId: number;
  /** The parent post of a reply; null for a discussion's first post. */
  parentId: number | null;
  forumCmid: number | null;
  forumName: string;
  discussionName: string;
  subject: string;
  author: string;
  authorId: number | null;
  /** Unix seconds (the post's `<time datetime>`), null when not shown. */
  time: number | null;
  /** The message HTML; Moodle wraps the matched words in `<span class="highlight">`. */
  message: string;
  unread: boolean;
}

interface SearchPage {
  posts: SearchPost[];
  /** The paging bar offers a page after the current one. */
  hasNextPage: boolean;
}

const positive = (n: number) => (Number.isSafeInteger(n) && n > 0 ? n : null);

/** The `#p<id>` fragment of a discuss.php link. */
const fragmentPost = (href: string) => positive(Number(/#p(\d+)$/.exec(href)?.[1]));

interface HeadingLinks {
  forum: HtmlElement | null;
  discussion: HtmlElement | null;
  parent: HtmlElement | null;
}

/** Forum, discussion and (replies) parent links of a result's subject heading, in that order. */
function headingLinks(heading: string): HeadingLinks {
  const anchors = findAll(heading, { attr: 'href', tag: 'a' });
  const discuss = anchors.filter((a) => attr(a.attrs, 'href').includes('/mod/forum/discuss.php?'));
  return {
    forum: anchors.find((a) => attr(a.attrs, 'href').includes('/mod/forum/view.php?')) ?? null,
    discussion: discuss.find((a) => fragmentPost(attr(a.attrs, 'href')) === null) ?? null,
    parent: discuss.find((a) => fragmentPost(attr(a.attrs, 'href')) !== null) ?? null,
  };
}

/** The author link (`/user/view.php?id=`) and the time in the post header. */
function byline(article: string): { author: string; authorId: number | null; time: number | null } {
  const header = findFirst(article, { attr: 'id', tag: 'header' })?.inner ?? article;
  const anchors = findAll(header, { attr: 'href', tag: 'a' });
  const user = anchors.find((a) => attr(a.attrs, 'href').includes('/user/view.php?'));
  return {
    author: user ? text(user.inner) : '',
    authorId: user ? queryInt(attr(user.attrs, 'href'), 'id') : null,
    time: timesIn(header)[0] ?? null,
  };
}

function searchPost(article: HtmlElement): SearchPost | null {
  const postId = positive(Number(attr(article.attrs, 'data-post-id')));
  const heading = findFirst(article.outer, { attr: 'data-region-content', value: 'forum-post-core-subject' });
  if (postId === null || !heading) return null;
  const link = headingLinks(heading.inner);
  const discussionId = link.discussion ? queryInt(attr(link.discussion.attrs, 'href'), 'd') : null;
  if (discussionId === null) return null;
  const box = findFirst(article.outer, { attr: 'data-content', value: 'forum-post' });
  return {
    postId,
    discussionId,
    parentId: link.parent ? fragmentPost(attr(link.parent.attrs, 'href')) : null,
    forumCmid: link.forum ? queryInt(attr(link.forum.attrs, 'href'), 'id') : null,
    forumName: link.forum ? text(link.forum.inner) : '',
    discussionName: link.discussion ? text(link.discussion.inner) : '',
    subject: attr(heading.attrs, 'data-reply-subject'),
    ...byline(article.outer),
    message: findFirst(article.outer, { attr: 'id', value: `post-content-${postId}` })?.inner ?? '',
    unread: box ? attr(box.attrs, 'class').split(/\s+/).includes('unread') : false,
  };
}

/** The paging bar lists a page number above the active one. */
function hasNextPage(html: string): boolean {
  const items = findAll(html, { attr: 'data-page-number', tag: 'li' });
  const active = items.find((li) => attr(li.attrs, 'class').split(/\s+/).includes('active'));
  const current = active ? Number(attr(active.attrs, 'data-page-number')) : Number.NaN;
  if (!Number.isFinite(current)) return false;
  return items.some((li) => Number(attr(li.attrs, 'data-page-number')) > current);
}

/** The result posts of a search page (none when nothing matches: Moodle then shows the search form). */
export function parseForumSearch(html: string): SearchPage {
  const main = mainRegion(html);
  const posts: SearchPost[] = [];
  for (const article of findAll(main, { attr: 'data-region', value: 'post', tag: 'article' })) {
    const post = searchPost(article);
    if (post) posts.push(post);
  }
  return { posts, hasNextPage: hasNextPage(main) };
}

/** One page (0-based) of Moodle's search over the course's forums: one request. */
async function searchCourseForums(
  web: WebSession,
  req: { courseId: number; query: string; page: number; perPage: number },
): Promise<SearchPage> {
  const q = new URLSearchParams({ id: String(req.courseId), search: req.query, perpage: String(req.perPage) });
  if (req.page > 0) q.set('page', String(req.page));
  return parseForumSearch((await web.page(`/mod/forum/search.php?${q}`)).html);
}

export interface CourseResults extends SearchPage {
  courseId: number;
  /** Moodle refused this course's search (no access, search disabled, ...): no posts. */
  failed: boolean;
}

/** The same result page of several courses, one request each; a course Moodle refuses comes back failed. */
function pageOfCourses(
  web: WebSession,
  req: { courseIds: number[]; query: string; page: number; perPage: number },
): Promise<CourseResults[]> {
  return Promise.all(
    req.courseIds.map(async (courseId): Promise<CourseResults> => {
      try {
        return { courseId, failed: false, ...(await searchCourseForums(web, { ...req, courseId })) };
      } catch (e) {
        if (!(e instanceof MoodleError)) throw e;
        return { courseId, failed: true, posts: [], hasNextPage: false };
      }
    }),
  );
}

interface CourseSearch {
  /** Every result page read (all courses, all pages). */
  pages: CourseResults[];
  /** Courses not searched: over the call budget or refused by Moodle. */
  skipped: number;
  /** Courses with result pages left unread. */
  cut: number;
}

/**
 * Page 1 of every course, as many as `callsLeft()` allows (the rest are skipped), then the next page of the courses
 * that have more, up to `maxPages` pages, until `enough(pages)`. One request per course and page.
 */
export async function searchCourses(
  web: WebSession,
  req: {
    courseIds: number[];
    query: string;
    perPage: number;
    maxPages: number;
    callsLeft: () => number;
    enough: (pages: CourseResults[]) => boolean;
  },
): Promise<CourseSearch> {
  const pages: CourseResults[] = [];
  const more = new Map<number, boolean>();
  let pending = req.courseIds;
  let skipped = 0;
  for (let page = 0; page < req.maxPages && pending.length > 0; page++) {
    const courseIds = pending.slice(0, Math.min(pending.length, req.callsLeft()));
    const batch = await pageOfCourses(web, { courseIds, query: req.query, page, perPage: req.perPage });
    if (page === 0) skipped = pending.length - batch.filter((p) => !p.failed).length;
    for (const p of batch) more.set(p.courseId, p.hasNextPage);
    pages.push(...batch);
    pending = req.enough(pages) ? [] : batch.filter((p) => p.hasNextPage).map((p) => p.courseId);
  }
  return { pages, skipped, cut: [...more.values()].filter(Boolean).length };
}
