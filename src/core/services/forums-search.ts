/** Keyword search over forum discussions (subject + first post) and, optionally, private messages. */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, MoodleUnavailable, NeedsReconnect, WmmError } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import { fromTs, toMs } from '../time';
import type { DiscussionSummary, IsoJst } from '../types';
import { listCourses } from './courses';
import {
  type ForumRef,
  fetchRawDiscussions,
  forumReadCap,
  mapDiscussion,
  nonEmptyForums,
  type RawDiscussion,
  readEach,
  webCallsLeft,
} from './forums';
import { forumsInScope } from './forums-list';
import { clampInt, courseNameMap } from './shared';

/** Discussions read per forum: one Moodle call per forum whatever the page size. */
const PER_FORUM = 20;
const MAX_TERMS = 8;
/** First posts are cut before folding: a Worker has ~10 ms of CPU for up to 15 forums x PER_FORUM discussions. */
const BODY_MAX_HTML_CHARS = 6000;
/** ...and cut harder when many forums are scanned. */
const BODY_MAX_HTML_CHARS_MANY = 2000;
const MANY_FORUMS = 5;
const SNIPPET_BEFORE = 50;
const SNIPPET_AFTER = 110;
const MESSAGE_HITS = 10;
const MESSAGE_TIMEOUT_MS = 5000;

interface ForumSearchHit extends DiscussionSummary {
  /** Text around the first match (first post), single line. */
  snippet: string;
  /** Every search word occurs in the subject itself. */
  inSubject: boolean;
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
  /** Discussions read per forum (the newest ones). */
  perForum: number;
  skippedForums: number;
  /** Web channel: some forums were searched by subject only (why, and how many); absent = first posts too. */
  bodyNote?: string;
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

/** Text around the earliest word; positions come from the very string that is cut (case-insensitive search). */
function snippetOf(flat: string, terms: string[]): string {
  const first = new RegExp(terms.map(escapeRegExp).join('|'), 'i').exec(flat)?.index ?? 0;
  const from = Math.max(0, first - SNIPPET_BEFORE);
  const piece = flat.slice(from, first + SNIPPET_AFTER);
  return `${from > 0 ? '…' : ''}${piece}${first + SNIPPET_AFTER < flat.length ? '…' : ''}`;
}

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
  // Without a first post (web channel, subjects only) the snippet is the subject.
  return { ...summary, snippet: snippetOf(body.flat || subject.flat, terms), inSubject };
}

const modifiedMs = (d: DiscussionSummary) => (d.modifiedAt ? toMs(d.modifiedAt) : 0);

function rank(a: ForumSearchHit, b: ForumSearchHit): number {
  return Number(b.inSubject) - Number(a.inSubject) || modifiedMs(b) - modifiedMs(a);
}

// ------------------------------------------------------------------ forums

/** Announcement forums first (on the web channel: likely ones), so the per-call forum cap never drops them. */
const newsFirst = (refs: ForumRef[], likely: Set<number>) => {
  const news = (r: ForumRef) => r.kind === 'news' || (r.cmid !== null && likely.has(r.cmid));
  return [...refs].sort((a, b) => Number(news(b)) - Number(news(a)));
};

/**
 * Web channel: the forums whose first posts are read too, one more request each, within the budget left after the
 * `read` forums' lists. Only untracked forums: reading first posts marks them read on tracked ones.
 */
function quietBodies(api: MoodleApi, read: ForumRef[]): Set<ForumRef> {
  if (api.channel !== 'web') return new Set(read);
  const spare = Math.max(0, webCallsLeft(api) - read.length);
  return new Set(read.filter((r) => r.forumType === 'forum' && r.tracked === false).slice(0, spare));
}

interface ScanResult<T> {
  items: T[];
  skipped: number;
  /** Forums read whose first posts were not (web channel). */
  subjectOnly: number;
}

/**
 * The shared forum scan: the newest PER_FORUM discussions of every forum of the course (or of the courses in scope),
 * announcements first, within readEach's forum cap and the call budget. `visit` maps one discussion to a result or
 * null to drop it; it is told how many characters of a first post to look at (fewer when many forums are scanned).
 * `bodies`: the caller reads `message`; on the web channel only some forums can give it (quietBodies).
 */
export async function scanDiscussions<T>(
  ctx: ServiceContext,
  api: MoodleApi,
  req: {
    courseId?: number;
    bodies?: boolean;
    visit: (raw: RawDiscussion, ref: ForumRef, courseName: string, bodyChars: number) => T | null;
  },
): Promise<ScanResult<T>> {
  const courseIds = req.courseId != null ? [req.courseId] : (await listCourses(ctx)).map((c) => c.id);
  const [scope, names] = await Promise.all([forumsInScope(api, courseIds), courseNameMap(ctx)]);
  const order = newsFirst(scope.refs, scope.likelyNews);
  const cap = forumReadCap(api);
  const read = nonEmptyForums(order).slice(0, cap);
  const bodies = req.bodies ? quietBodies(api, read) : new Set<ForumRef>();
  const bodyChars = read.length > MANY_FORUMS ? BODY_MAX_HTML_CHARS_MANY : BODY_MAX_HTML_CHARS;
  const found = await readEach(
    order,
    async (ref) => {
      const name = names.get(ref.courseId) ?? `Course ${ref.courseId}`;
      const list = await fetchRawDiscussions(api, ref, { limit: PER_FORUM, messages: bodies.has(ref) });
      return list.map((raw) => req.visit(raw, ref, name, bodyChars)).filter((x): x is Exclude<T, null> => x !== null);
    },
    cap,
  );
  const subjectOnly = req.bodies ? read.length - bodies.size : 0;
  return { items: found.items, skipped: found.skipped + scope.skipped, subjectOnly };
}

async function searchDiscussions(
  ctx: ServiceContext,
  api: MoodleApi,
  req: { terms: string[]; courseId?: number },
): Promise<{ hits: ForumSearchHit[]; skipped: number; subjectOnly: number }> {
  const { items, skipped, subjectOnly } = await scanDiscussions(ctx, api, {
    courseId: req.courseId,
    bodies: true,
    visit: (raw, ref, courseName, bodyChars) => matchDiscussion(raw, ref, req.terms, { courseName, bodyChars }),
  });
  return { hits: items, skipped, subjectOnly };
}

/** The note for `n` forums searched by subject only; nothing when there are none. */
const bodyNoteOf = (n: number): { bodyNote?: string } =>
  n > 0
    ? {
        bodyNote:
          `${n} forum${n === 1 ? ' was' : 's were'} searched by subject only: through the Moodle web session first ` +
          'posts are read only where that marks nothing read (untracked forums) and the call budget allows.',
      }
    : {};

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
 * Words (all must occur, any case, full-width forms folded) in discussion subjects and first posts of the forums of
 * the user's courses, newest discussions of each forum only. Subject matches first, then the most recently active.
 */
export async function searchForums(ctx: ServiceContext, opts: SearchOptions): Promise<ForumSearchResult> {
  const terms = searchTerms(opts.query);
  const limit = clampInt(opts.limit, 20, 1, 50);
  const api = await ctx.moodle();
  const [found, messages] = await Promise.all([
    searchDiscussions(ctx, api, { terms, courseId: opts.courseId }),
    opts.includeMessages ? searchMessages(api, opts.query.trim()) : null,
  ]);
  return {
    query: opts.query.trim(),
    hits: found.hits.sort(rank).slice(0, limit),
    perForum: PER_FORUM,
    skippedForums: found.skipped,
    ...bodyNoteOf(found.subjectOnly),
    messages: messages?.messages ?? null,
    messagesNote: messages?.note ?? null,
  };
}
