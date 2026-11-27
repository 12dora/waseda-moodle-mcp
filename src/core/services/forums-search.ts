/**
 * Keyword search over forum posts and, optionally, private messages. Web service: the subjects and first posts of the
 * newest discussions of each forum. Web channel: Moodle's own search page per course (every post of the standard
 * forums, marks nothing read); Advanced Forums have no such page there and are searched by their newest subjects.
 */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, MoodleUnavailable, NeedsReconnect, WmmError } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import { type CourseResults, type SearchPost, searchCourses } from '../moodle/web/parse/forum-search';
import type { WebSession } from '../moodle/web/types';
import { fromTs, toMs } from '../time';
import type { DiscussionSummary, IsoJst } from '../types';
import { listCourses } from './courses';
import {
  type ForumRef,
  type ForumType,
  fetchRawDiscussions,
  forumReadCap,
  mapDiscussion,
  nonEmptyForums,
  type RawDiscussion,
  readEach,
  webCallsLeft,
} from './forums';
import { type CourseForums, courseStructures, forumsInScope } from './forums-list';
import { clampInt, courseNameMap } from './shared';

/** Discussions read per forum: one Moodle call per forum whatever the page size. */
const PER_FORUM = 20;
const MAX_TERMS = 8;
/** First posts are cut before folding: a Worker has ~10 ms of CPU for up to 15 forums x PER_FORUM discussions. */
const BODY_MAX_HTML_CHARS = 6000;
/** ...and cut harder when many forums are scanned. */
const BODY_MAX_HTML_CHARS_MANY = 2000;
const MANY_FORUMS = 5;
/** Web channel: posts per search page asked of Moodle (it shows 10 unless told) and pages read per course at most. */
const SEARCH_PER_PAGE = 20;
const SEARCH_PAGES = 2;
const SNIPPET_BEFORE = 50;
const SNIPPET_AFTER = 110;
const MESSAGE_HITS = 10;
const MESSAGE_TIMEOUT_MS = 5000;

/**
 * One discussion. Web channel search results show posts, not discussions: `replies` and `unread` are null, `forumId`
 * is 0 (the page names the forum by its cmid only), `forumKind` is '' and `modifiedAt` is the newest matching post.
 */
interface ForumSearchHit extends Omit<DiscussionSummary, 'replies'> {
  replies: number | null;
  /** Text around the first match (first post; web channel: the newest matching post), single line. */
  snippet: string;
  /** Every search word occurs in the subject itself. */
  inSubject: boolean;
  /** Web channel: the newest matching post (get_discussion post_id) and how many posts of the discussion matched. */
  postId?: number;
  matchingPosts?: number;
}

/** Web channel: what Moodle's search page covered. */
interface FullTextScope {
  /** Courses whose standard forums were searched by Moodle (every post). */
  courses: number;
  /** Courses left out for the call budget. */
  skippedCourses: number;
  /** Courses with more matching posts than the pages read. */
  cutCourses: number;
  /** Advanced Forums searched by the subjects of their newest `perForum` discussions only. */
  advancedForums: number;
}

interface MessageHit {
  conversationId: number | null;
  userId: number | null;
  name: string;
  text: string;
  sentAt: IsoJst | null;
  fromMe: boolean;
}

export interface ForumSearchResult {
  query: string;
  hits: ForumSearchHit[];
  /** Discussions read per forum (the newest ones; web channel: Advanced Forums only). */
  perForum: number;
  skippedForums: number;
  /** Web channel only: Moodle's own search was used (see FullTextScope). */
  fullText?: FullTextScope;
  /** null = messages were not requested. */
  messages: MessageHit[] | null;
  messagesNote: string | null;
}

interface SearchOptions {
  query: string;
  courseId?: number;
  includeMessages?: boolean;
  limit?: number;
}

// ------------------------------------------------------------------ matching

/** Whitespace-collapsed NFKC text and its case-folded twin (lower-casing may change the length: never mix indexes). */
export function fold(s: string): { flat: string; lower: string } {
  const flat = s.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return { flat, lower: flat.toLowerCase() };
}

export function searchTerms(query: string): string[] {
  const terms = fold(query).lower.split(' ').filter(Boolean);
  if (terms.length === 0) throw new InvalidInput('Give at least one search word.');
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

const escapeRegExp = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text around position `first` of `flat`. */
function snippetAt(flat: string, first: number): string {
  const from = Math.max(0, first - SNIPPET_BEFORE);
  const piece = flat.slice(from, first + SNIPPET_AFTER);
  return `${from > 0 ? '…' : ''}${piece}${first + SNIPPET_AFTER < flat.length ? '…' : ''}`;
}

/** Text around the earliest word; positions come from the very string that is cut (case-insensitive search). */
const snippetOf = (flat: string, terms: string[]) =>
  snippetAt(flat, new RegExp(terms.map(escapeRegExp).join('|'), 'i').exec(flat)?.index ?? 0);

/** Cheap tag-stripping instead of a Markdown conversion: every first post of every forum goes through here. */
const plainText = (html: string | null | undefined, maxHtmlChars: number) =>
  decodeEntities((html ?? '').slice(0, maxHtmlChars).replace(/<[^>]*>/g, ' '));

/** The hit for one discussion when every word occurs in its subject or first post; null otherwise. */
function matchDiscussion(
  raw: RawDiscussion,
  ref: ForumRef,
  terms: string[],
  scan: { courseName: string; bodyChars: number },
): ForumSearchHit | null {
  const summary = mapDiscussion(raw, ref, scan.courseName);
  const subject = fold(summary.subject);
  const body = fold(plainText(raw.message, scan.bodyChars));
  if (!terms.every((t) => subject.lower.includes(t) || body.lower.includes(t))) return null;
  const inSubject = terms.every((t) => subject.lower.includes(t));
  // Without a first post (web channel Advanced Forums: subjects only) the snippet is the subject.
  return { ...summary, snippet: snippetOf(body.flat || subject.flat, terms), inSubject };
}

const modifiedMs = (d: { modifiedAt: IsoJst | null }) => (d.modifiedAt ? toMs(d.modifiedAt) : 0);

function rank(a: ForumSearchHit, b: ForumSearchHit): number {
  return Number(b.inSubject) - Number(a.inSubject) || modifiedMs(b) - modifiedMs(a);
}

// ------------------------------------------------------------------ forums

/** Announcement forums first (on the web channel: likely ones), so the per-call forum cap never drops them. */
const newsFirst = (refs: ForumRef[], likely: Set<number>) => {
  const news = (r: ForumRef) => r.kind === 'news' || (r.cmid !== null && likely.has(r.cmid));
  return [...refs].sort((a, b) => Number(news(b)) - Number(news(a)));
};

interface ScanResult<T> {
  items: T[];
  skipped: number;
  /** Forums read (or tried). */
  forums: number;
}

/**
 * The shared forum scan: the newest PER_FORUM discussions of every forum of the course (or of the courses in scope;
 * `scope`: only these courses and forum types), announcements first, within readEach's forum cap and the call budget.
 * `visit` maps one discussion to a result or null to drop it; it is told how many characters of a first post to look
 * at (fewer when many forums are scanned). The web channel's lists carry no first posts (`message` is null there).
 * `names`: the course names when the caller has them already.
 */
export async function scanDiscussions<T>(
  ctx: ServiceContext,
  api: MoodleApi,
  req: {
    courseId?: number;
    scope?: { courseIds: number[]; types: ForumType[]; structures?: CourseForums[] };
    names?: Map<number, string>;
    visit: (raw: RawDiscussion, ref: ForumRef, courseName: string, bodyChars: number) => T | null;
  },
): Promise<ScanResult<T>> {
  const courseIds = req.scope?.courseIds ?? (await scopeCourseIds(ctx, req.courseId));
  const [scope, names] = await Promise.all([
    forumsInScope(api, courseIds, { types: req.scope?.types, structures: req.scope?.structures }),
    req.names ?? courseNameMap(ctx),
  ]);
  const order = newsFirst(scope.refs, scope.likelyNews);
  const cap = forumReadCap(api);
  const read = nonEmptyForums(order).slice(0, cap);
  const bodyChars = read.length > MANY_FORUMS ? BODY_MAX_HTML_CHARS_MANY : BODY_MAX_HTML_CHARS;
  const found = await readEach(
    order,
    async (ref) => {
      const name = names.get(ref.courseId) ?? `Course ${ref.courseId}`;
      const list = await fetchRawDiscussions(api, ref, { limit: PER_FORUM });
      return list.map((raw) => req.visit(raw, ref, name, bodyChars)).filter((x): x is Exclude<T, null> => x !== null);
    },
    cap,
  );
  return { items: found.items, skipped: found.skipped + scope.skipped, forums: read.length };
}

const scopeCourseIds = async (ctx: ServiceContext, courseId?: number): Promise<number[]> =>
  courseId != null ? [courseId] : (await listCourses(ctx)).map((c) => c.id);

type CourseNames = Map<number, string>;

interface Found {
  hits: ForumSearchHit[];
  skipped: number;
  fullText?: FullTextScope;
}

/** The forum scan over `types` of the courses, matching subjects and first posts. */
async function searchDiscussions(
  ctx: ServiceContext,
  api: MoodleApi,
  req: { terms: string[]; courseIds: number[]; types: ForumType[]; names: CourseNames; structures?: CourseForums[] },
): Promise<Found & { forums: number }> {
  const { items, skipped, forums } = await scanDiscussions(ctx, api, {
    scope: { courseIds: req.courseIds, types: req.types, structures: req.structures },
    names: req.names,
    visit: (raw, ref, courseName, bodyChars) => matchDiscussion(raw, ref, req.terms, { courseName, bodyChars }),
  });
  return { hits: items, skipped, forums };
}

// ------------------------------------------------------------------ web channel: Moodle's search page

const discussionsIn = (pages: CourseResults[]) => new Set(pages.flatMap((p) => p.posts.map((x) => x.discussionId)));

const MARK = '\u0001';
/** Moodle wraps each matched word in this span; the word stays, the span becomes a position mark. */
const HIGHLIGHT = /<span class="highlight">([^<]*)<\/span>/gi;

/** Text around Moodle's first highlighted word (else around the earliest search word). */
function highlightSnippet(html: string, terms: string[]): string {
  const flat = fold(plainText(html.replace(HIGHLIGHT, `${MARK}$1`), BODY_MAX_HTML_CHARS)).flat;
  const at = flat.indexOf(MARK);
  const clean = flat.replaceAll(MARK, '');
  return at >= 0 ? snippetAt(clean, at) : snippetOf(clean, terms);
}

function postHit(post: SearchPost, course: { id: number; name: string }, terms: string[]): ForumSearchHit {
  const subject = post.discussionName || post.subject;
  const first = post.parentId === null;
  return {
    forumType: 'forum',
    forumId: 0,
    forumCmid: post.forumCmid,
    forumName: post.forumName,
    forumKind: '',
    courseId: course.id,
    courseName: course.name,
    discussionId: post.discussionId,
    firstPostId: first ? post.postId : 0,
    subject,
    author: post.author,
    createdAt: first ? fromTs(post.time) : null,
    modifiedAt: fromTs(post.time),
    replies: null,
    unread: null,
    pinned: false,
    canCreateDiscussions: false,
    dueAt: null,
    cutoffAt: null,
    snippet: highlightSnippet(post.message, terms) || fold(subject).flat,
    inSubject: terms.every((t) => fold(subject).lower.includes(t)),
    postId: post.postId,
    matchingPosts: 1,
  };
}

/** One hit per discussion: its newest matching post (results come newest first), counting the others. */
function webHits(pages: CourseResults[], terms: string[], names: CourseNames): ForumSearchHit[] {
  const byDiscussion = new Map<number, ForumSearchHit>();
  for (const page of pages) {
    const course = { id: page.courseId, name: names.get(page.courseId) ?? `Course ${page.courseId}` };
    for (const post of page.posts) {
      const hit = byDiscussion.get(post.discussionId);
      if (!hit) {
        byDiscussion.set(post.discussionId, postHit(post, course, terms));
        continue;
      }
      hit.matchingPosts = (hit.matchingPosts ?? 1) + 1;
      if (post.parentId === null) {
        hit.firstPostId = post.postId;
        hit.createdAt = fromTs(post.time);
      }
    }
  }
  return [...byDiscussion.values()];
}

/**
 * Web channel: Moodle's search page for the courses with standard forums (their structure, one ajax batch, tells
 * which), at most SEARCH_PAGES pages each; Advanced Forums by the scan (subjects of the newest discussions).
 */
async function webSearch(
  ctx: ServiceContext,
  api: MoodleApi,
  req: { web: WebSession; query: string; terms: string[]; courseIds: number[]; limit: number; names: CourseNames },
): Promise<Found> {
  const courses = await courseStructures(api, req.courseIds);
  const withForums = courses.filter((c) => c.forums !== 0).map((c) => c.courseId);
  const hsuCourses = courses.filter((c) => c.hsuforums !== 0);
  const read = await searchCourses(req.web, {
    courseIds: withForums,
    query: req.query,
    perPage: SEARCH_PER_PAGE,
    maxPages: SEARCH_PAGES,
    callsLeft: () => webCallsLeft(api),
    enough: (pages) => discussionsIn(pages).size >= req.limit,
  });
  const hsu =
    hsuCourses.length > 0
      ? await searchDiscussions(ctx, api, {
          ...req,
          courseIds: hsuCourses.map((c) => c.courseId),
          types: ['hsuforum'],
          structures: hsuCourses,
        })
      : { hits: [], skipped: 0, forums: 0 };
  return {
    hits: [...webHits(read.pages, req.terms, req.names), ...hsu.hits],
    skipped: hsu.skipped,
    fullText: {
      courses: withForums.length - read.skipped,
      skippedCourses: read.skipped,
      cutCourses: read.cut,
      advancedForums: hsu.forums,
    },
  };
}

/**
 * Moodle's search page where the web session serves this call, else the forum scan. The channel is read after the
 * course names, the first call (it settles a fresh client's channel).
 */
async function findDiscussions(
  ctx: ServiceContext,
  api: MoodleApi,
  req: { query: string; terms: string[]; courseId?: number; limit: number },
): Promise<Found> {
  const [courseIds, names] = await Promise.all([scopeCourseIds(ctx, req.courseId), courseNameMap(ctx)]);
  const web = api.channel === 'web' ? api.web : undefined;
  if (web && courseIds.length > 0) return webSearch(ctx, api, { ...req, web, courseIds, names });
  return searchDiscussions(ctx, api, { terms: req.terms, courseIds, types: ['forum', 'hsuforum'], names });
}

// ------------------------------------------------------------------ messages

interface RawMessageHit {
  userid?: number | null;
  fullname?: string | null;
  lastmessage?: string | null;
  lastmessagedate?: number | null;
  timecreated?: number | null;
  sentfromcurrentuser?: boolean | null;
  conversationid?: number | null;
}

/** Rejects after `ms` so a slow message search cannot hold the whole answer. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MoodleUnavailable('Message search timed out.')), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function mapMessageHit(raw: RawMessageHit): MessageHit {
  return {
    conversationId: raw.conversationid ?? null,
    userId: raw.userid ?? null,
    name: decodeEntities(raw.fullname ?? ''),
    text: htmlToMarkdown(raw.lastmessage, { maxChars: 300 }),
    sentAt: fromTs(raw.lastmessagedate ?? raw.timecreated),
    fromMe: raw.sentfromcurrentuser === true,
  };
}

/** One call, short timeout; any failure except an expired connection turns into a note. */
async function searchMessages(api: MoodleApi, query: string): Promise<{ messages: MessageHit[]; note: string | null }> {
  try {
    const res = await withTimeout(
      api.call<{ contacts?: RawMessageHit[] | null }>('core_message_data_for_messagearea_search_messages', {
        userid: api.moodleUserId,
        search: query,
        limitfrom: 0,
        limitnum: MESSAGE_HITS,
      }),
      MESSAGE_TIMEOUT_MS,
    );
    return { messages: (res?.contacts ?? []).map(mapMessageHit), note: null };
  } catch (e) {
    if (e instanceof NeedsReconnect || !(e instanceof WmmError)) throw e;
    return { messages: [], note: 'Message search was skipped: Moodle did not answer it.' };
  }
}

// ------------------------------------------------------------------ service

/**
 * Words (all must occur, any case) in the forums of the user's courses. Web service: subjects and first posts of the
 * newest discussions of each forum (full-width forms folded). Web channel: Moodle's own search over every post (the
 * words go to Moodle as typed). Subject matches first, then the most recently active.
 */
export async function searchForums(ctx: ServiceContext, opts: SearchOptions): Promise<ForumSearchResult> {
  const terms = searchTerms(opts.query);
  const query = opts.query.trim();
  const limit = clampInt(opts.limit, 20, 1, 50);
  const api = await ctx.moodle();
  const [found, messages] = await Promise.all([
    findDiscussions(ctx, api, { query, terms, courseId: opts.courseId, limit }),
    opts.includeMessages ? searchMessages(api, query) : null,
  ]);
  return {
    query,
    hits: found.hits.sort(rank).slice(0, limit),
    perForum: PER_FORUM,
    skippedForums: found.skipped,
    ...(found.fullText ? { fullText: found.fullText } : {}),
    messages: messages?.messages ?? null,
    messagesNote: messages?.note ?? null,
  };
}
