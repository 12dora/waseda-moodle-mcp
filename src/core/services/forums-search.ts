/** Keyword search over forum discussions (subject + first post) and, optionally, private messages. */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, MoodleUnavailable, NeedsReconnect, WmmError } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import { fromTs, toMs } from '../time';
import type { DiscussionSummary, IsoJst } from '../types';
import { listCourses } from './courses';
import {
  type ForumRef,
  fetchForumsOfTypes,
  fetchRawDiscussions,
  mapDiscussion,
  type RawDiscussion,
  readEach,
} from './forums';
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
  return { ...summary, snippet: snippetOf(body.flat, terms), inSubject };
}

const modifiedMs = (d: DiscussionSummary) => (d.modifiedAt ? toMs(d.modifiedAt) : 0);

function rank(a: ForumSearchHit, b: ForumSearchHit): number {
  return Number(b.inSubject) - Number(a.inSubject) || modifiedMs(b) - modifiedMs(a);
}

// ------------------------------------------------------------------ forums

/** Announcement forums first, so the per-call forum cap never drops them. */
const newsFirst = (refs: ForumRef[]) => [...refs].sort((a, b) => Number(b.kind === 'news') - Number(a.kind === 'news'));

/**
 * The shared forum scan: the newest PER_FORUM discussions of every forum of the course (or of the courses in scope),
 * announcements first, within readEach's forum cap. `visit` maps one discussion to a result or null to drop it; it
 * is told how many characters of a first post to look at (fewer when many forums are scanned).
 */
export async function scanDiscussions<T>(
  ctx: ServiceContext,
  api: MoodleApi,
  req: {
    courseId?: number;
    visit: (raw: RawDiscussion, ref: ForumRef, courseName: string, bodyChars: number) => T | null;
  },
): Promise<{ items: T[]; skipped: number }> {
  const courseIds = req.courseId != null ? [req.courseId] : (await listCourses(ctx)).map((c) => c.id);
  const [refs, names] = await Promise.all([
    fetchForumsOfTypes(api, ['forum', 'hsuforum'], courseIds),
    courseNameMap(ctx),
  ]);
  const many = refs.filter((r) => r.numDiscussions !== 0).length > MANY_FORUMS;
  const bodyChars = many ? BODY_MAX_HTML_CHARS_MANY : BODY_MAX_HTML_CHARS;
  return readEach(newsFirst(refs), async (ref) => {
    const name = names.get(ref.courseId) ?? `Course ${ref.courseId}`;
    const found = (await fetchRawDiscussions(api, ref, PER_FORUM)).map((raw) => req.visit(raw, ref, name, bodyChars));
    return found.filter((x): x is Exclude<T, null> => x !== null);
  });
}

async function searchDiscussions(
  ctx: ServiceContext,
  api: MoodleApi,
  req: { terms: string[]; courseId?: number },
): Promise<{ hits: ForumSearchHit[]; skipped: number }> {
  const { items, skipped } = await scanDiscussions(ctx, api, {
    courseId: req.courseId,
    visit: (raw, ref, courseName, bodyChars) => matchDiscussion(raw, ref, req.terms, { courseName, bodyChars }),
  });
  return { hits: items, skipped };
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
    messages: messages?.messages ?? null,
    messagesNote: messages?.note ?? null,
  };
}
