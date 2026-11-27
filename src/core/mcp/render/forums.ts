import type { ForumSearchResult } from '../../services/forums-search';
import { fmt, fmtDue } from '../../time';
import type { Discussion, DiscussionList, DiscussionSummary, ForumListEntry, Post, TruncatedForum } from '../../types';
import { assemble, assembleTail, clip, type Entry, fileLines, GET_FILE_HINT, oneLine, plural } from './common';

const START_HINT = 'To start a discussion, prepare_forum_post with forum_id.';

/** Moodle `news` is the announcements forum; other kinds are shown as returned. */
function kindLabel(kind: string): string {
  return kind === 'news' ? 'announcements' : kind;
}

function moduleNote(forumType: string): string {
  return forumType === 'hsuforum' ? ', Advanced Forum' : '';
}

function forumIds(f: { forumId: number; forumCmid: number | null }): string {
  const cmid = f.forumCmid != null ? `, cmid ${f.forumCmid}` : '';
  return `forum_id ${f.forumId}${cmid}`;
}

function postingBits(canCreate: boolean, dueAt: string | null, cutoffAt: string | null): string {
  const post = canCreate ? 'can post' : 'cannot post';
  const due = dueAt ? `, due ${fmtDue(dueAt)}` : '';
  const cutoff = cutoffAt ? `, cutoff ${fmtDue(cutoffAt)}` : '';
  return `${post}${due}${cutoff}`;
}

function discussionFacts(d: DiscussionSummary): string {
  const unread = d.unread ? `, ${d.unread} unread` : '';
  const pin = d.pinned ? '[pinned] ' : '';
  return `- ${pin}${oneLine(d.subject, 90)} — ${oneLine(d.author, 40)}, ${fmt(d.modifiedAt)} — ${plural(d.replies, 'reply', 'replies')}${unread}`;
}

export function discussionLine(d: DiscussionSummary, opts: { underForum?: boolean } = {}): string {
  const facts = discussionFacts(d);
  if (opts.underForum) return `${facts} (discussion_id ${d.discussionId})`;
  const kind = `${kindLabel(d.forumKind)}${moduleNote(d.forumType)}`;
  const cmid = d.forumCmid != null ? `, cmid ${d.forumCmid}` : '';
  const where = `${oneLine(d.forumName, 50)} (${kind}) / ${oneLine(d.courseName, 50)}`;
  return `${facts} — ${where} (forum_id ${d.forumId}, discussion_id ${d.discussionId}${cmid})`;
}

function forumHeading(f: ForumListEntry | DiscussionSummary): string {
  const kind = `${kindLabel(f.forumKind)}${moduleNote(f.forumType)}`;
  const title = `${oneLine(f.forumName, 50)} — ${oneLine(f.courseName, 40)}, ${kind}`;
  return `${title}, ${postingBits(f.canCreateDiscussions, f.dueAt, f.cutoffAt)} (${forumIds(f)})`;
}

function moreLine(t: TruncatedForum): string {
  const cmid = t.forumCmid != null ? `forum_cmid ${t.forumCmid}` : `forum_id ${t.forumId}`;
  const n = t.remaining != null ? `${t.remaining} more` : 'more discussions';
  return `  (${n}; pass ${cmid}, page ${t.nextPage}, limit ${t.pageSize})`;
}

function groupKey(f: { forumType: string; forumId: number }): string {
  return `${f.forumType}:${f.forumId}`;
}

function cutFor(r: DiscussionList, f: { forumType: string; forumId: number }): TruncatedForum | undefined {
  const key = groupKey(f);
  return r.truncatedForums.find((t) => groupKey(t) === key);
}

function groupByForum(discussions: DiscussionSummary[]): DiscussionSummary[][] {
  const order: string[] = [];
  const groups = new Map<string, DiscussionSummary[]>();
  for (const d of discussions) {
    const key = groupKey(d);
    const existing = groups.get(key);
    if (existing) {
      existing.push(d);
      continue;
    }
    groups.set(key, [d]);
    order.push(key);
  }
  return order.map((key) => groups.get(key) ?? []);
}

function pushSection(entries: Entry[], heading: string, items: Entry[]): void {
  if (entries.length > 0) entries.push({ text: '' });
  entries.push({ text: heading }, ...items);
}

/** item: true so assemble does not strip this as a dangling heading */
function cutItem(r: DiscussionList, f: { forumType: string; forumId: number }): Entry | undefined {
  const cut = cutFor(r, f);
  return cut ? { text: moreLine(cut), item: true } : undefined;
}

function listEntries(r: DiscussionList): Entry[] {
  const entries: Entry[] = [];
  const listed = new Set<string>();
  for (const list of groupByForum(r.discussions)) {
    const first = list[0];
    if (!first) continue;
    listed.add(groupKey(first));
    const items: Entry[] = list.map((d) => ({ text: discussionLine(d, { underForum: true }), item: true }));
    const more = cutItem(r, first);
    if (more) items.push(more);
    pushSection(entries, forumHeading(first), items);
  }
  for (const f of r.forums) {
    const more = cutItem(r, f);
    if (!more || listed.has(groupKey(f))) continue;
    listed.add(groupKey(f));
    pushSection(entries, forumHeading(f), [more]);
  }
  return entries;
}

function emptyForumBody(f: ForumListEntry, skipped: number): string {
  if (skipped > 0) return '  This forum could not be read.';
  if (f.numDiscussions === 0) return '  No discussions yet.';
  return '  No discussions match this page or filter.';
}

function emptyForumEntries(r: DiscussionList): Entry[] {
  const entries: Entry[] = [];
  for (const f of r.forums) {
    const items: Entry[] = [{ text: emptyForumBody(f, r.skippedForums), item: true }];
    const more = cutItem(r, f);
    if (more) items.push(more);
    pushSection(entries, forumHeading(f), items);
  }
  return entries;
}

function canStart(r: DiscussionList): boolean {
  return r.forums.some((f) => f.canCreateDiscussions) || r.discussions.some((d) => d.canCreateDiscussions);
}

export function renderDiscussions(
  r: Pick<DiscussionList, 'discussions' | 'skippedForums'> &
    Partial<Pick<DiscussionList, 'forums' | 'truncatedForums'>>,
): string {
  const list: DiscussionList = {
    forums: r.forums ?? [],
    discussions: r.discussions,
    skippedForums: r.skippedForums,
    truncatedForums: r.truncatedForums ?? [],
  };
  const footer = [
    ...(canStart(list) ? [START_HINT] : []),
    ...(list.skippedForums > 0
      ? [`(${plural(list.skippedForums, 'forum')} not checked; pass course_id or forum_cmid to look at specific ones.)`]
      : []),
  ];
  let entries: Entry[] = [];
  if (list.discussions.length > 0) entries = listEntries(list);
  else if (list.forums.length === 1) entries = emptyForumEntries(list);
  if (entries.length === 0) return ['No discussions found.', ...footer].join('\n');
  const head =
    list.discussions.length > 0
      ? [`${plural(list.discussions.length, 'discussion')} (newest activity first; open one with get_discussion):`]
      : [];
  return assemble({ head, entries, footer, hint: 'lower limit or pass course_id / forum_cmid and page' });
}

function replyMark(p: Post, mixed: boolean): string {
  if (!mixed) return '';
  return p.canReply ? ', can reply' : ', cannot reply';
}

/** hsuforum replies also need the discussion id (its preview cannot find a post without it). */
function replyHint(d: Discussion): string {
  const s = d.summary;
  const start = s.canCreateDiscussions ? ` To start a discussion, prepare_forum_post with forum_id ${s.forumId}.` : '';
  const extra = s.forumType === 'hsuforum' ? ` and discussion_id ${s.discussionId}` : '';
  const replyable = d.posts.filter((p) => p.canReply);
  if (replyable.length === 0) return `Replying is not allowed in this discussion.${start}`;
  if (replyable.length < d.posts.length) {
    const ids = replyable.map((p) => p.id).join(', ');
    return `You can reply to post_id ${ids}: prepare_forum_post with reply_to_post_id${extra}.${start}`;
  }
  return `You can reply: prepare_forum_post with reply_to_post_id set to the post_id${extra}.${start}`;
}

export function renderDiscussion(d: Discussion): string {
  const s = d.summary;
  const kind = s.forumKind ? ` ${kindLabel(s.forumKind)}` : '';
  const mod = s.forumType === 'hsuforum' ? ' Advanced Forum' : '';
  const head = [
    `# ${oneLine(s.subject, 120)} —${kind}${mod} discussion ${s.discussionId}`,
    `${oneLine(s.forumName, 60)}${s.courseName ? ` / ${oneLine(s.courseName, 60)}` : ''} · ${plural(d.posts.length, 'post')}`,
    forumIds(s),
  ];
  if (d.forumIntro.trim()) head.push(clip(d.forumIntro, 400));
  const mixed = d.posts.some((p) => p.canReply) && d.posts.some((p) => !p.canReply);
  const per = Math.max(350, Math.floor(2800 / Math.max(1, d.posts.length)));
  const blocks = d.posts.map((p) => {
    const parent = p.parentId !== null ? `, parent_id ${p.parentId}` : '';
    const unread = p.unread ? ', unread' : '';
    const lines = [
      `### ${oneLine(p.author, 50)} — ${fmt(p.createdAt)} (post_id ${p.id}${parent}${unread}${replyMark(p, mixed)})`,
    ];
    if (p.subject && p.subject !== s.subject) lines.push(`Subject: ${oneLine(p.subject, 100)}`);
    lines.push(clip(p.message, per));
    if (p.attachments.length > 0) lines.push(...fileLines(p.attachments, 3, { hint: false }));
    return lines.join('\n');
  });
  const footer = [replyHint(d)];
  if (d.posts.some((p) => p.attachments.length > 0)) footer.push(GET_FILE_HINT);
  return assembleTail({ head, blocks, footer, noun: d.posts.length === 1 ? 'post' : 'posts' });
}

type MessageHit = NonNullable<ForumSearchResult['messages']>[number];

function messageLine(m: MessageHit): string {
  const ids = [
    m.conversationId !== null ? `conversation_id ${m.conversationId}` : null,
    m.userId !== null ? `user_id ${m.userId}` : null,
  ].filter(Boolean);
  const who = `${oneLine(m.name, 40)}${m.fromMe ? ' (you)' : ''}`;
  return `- ${who} — ${fmt(m.sentAt)}: "${oneLine(m.text, 120)}"${ids.length ? ` (${ids.join(', ')})` : ''}`;
}

function messageEntries(r: ForumSearchResult): Entry[] {
  if (r.messages === null) return [];
  const body: Entry[] = r.messages.map((m) => ({ text: messageLine(m), item: true }));
  if (body.length === 0 && !r.messagesNote) body.push({ text: 'No messages match.', item: true });
  return [{ text: '' }, { text: 'Messages (open with get_conversation, answer with prepare_message):' }, ...body];
}

type SearchHit = ForumSearchResult['hits'][number];

/**
 * A search hit: the discussion line; a hit of Moodle's own search (web channel: posts, no discussion counts) names
 * its newest matching post instead.
 */
function hitLine(d: SearchHit): string {
  if (d.replies !== null) return discussionLine({ ...d, replies: d.replies });
  const more = (d.matchingPosts ?? 1) > 1 ? `, ${d.matchingPosts} matching posts` : '';
  const where = `${oneLine(d.forumName, 50)} / ${oneLine(d.courseName, 50)}`;
  const ids = [
    `discussion_id ${d.discussionId}`,
    d.postId ? `post_id ${d.postId}` : null,
    d.forumCmid ? `cmid ${d.forumCmid}` : null,
  ];
  const match = `newest match ${oneLine(d.author, 40)}, ${fmt(d.modifiedAt)}${more}`;
  return `- ${oneLine(d.subject, 90)} — ${match} — ${where} (${ids.filter(Boolean).join(', ')})`;
}

/** What Moodle's own search (web channel) left out. */
function fullTextNotes(r: ForumSearchResult): string[] {
  const f = r.fullText;
  if (!f) return [];
  const notes: [number, string][] = [
    [f.skippedCourses, `${plural(f.skippedCourses, 'course')} not searched (call budget or refused); pass course_id.`],
    [f.cutCourses, `${plural(f.cutCourses, 'course')} with more matching posts than were read; add words.`],
    [f.advancedForums, `${plural(f.advancedForums, 'Advanced Forum')}: newest ${r.perForum} discussion subjects only.`],
  ];
  return notes.filter(([n]) => n > 0).map(([, note]) => `(${note})`);
}

function emptyHead(r: ForumSearchResult, query: string): string {
  const courses = r.fullText ? plural(r.fullText.courses, 'course') : null;
  if (courses) return `No forum posts match "${query}" (Moodle's search over every post of ${courses}).`;
  return `No discussions match "${query}" in the newest ${r.perForum} discussions of each forum.`;
}

export function renderForumSearch(r: ForumSearchResult): string {
  const query = oneLine(r.query, 60);
  const found = r.hits.length > 0;
  const head = [
    found
      ? `${plural(r.hits.length, 'discussion')} matching "${query}" (best first; open one with get_discussion):`
      : emptyHead(r, query),
  ];
  const footer = [
    ...(r.skippedForums > 0 ? [`(${plural(r.skippedForums, 'forum')} not searched; pass course_id to narrow.)`] : []),
    ...fullTextNotes(r),
    ...(r.messagesNote ? [`(${r.messagesNote})`] : []),
  ];
  const hits = r.hits.map((d) => ({ text: `${hitLine(d)}\n  > ${oneLine(d.snippet, 180)}`, item: true }));
  return assemble({ head, entries: [...hits, ...messageEntries(r)], footer, hint: 'lower limit or pass course_id' });
}
