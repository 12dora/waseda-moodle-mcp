import type { ForumSearchResult } from '../../services/forums-search';
import { fmt } from '../../time';
import type { Discussion, DiscussionSummary } from '../../types';
import { assemble, assembleTail, clip, type Entry, fileLines, GET_FILE_HINT, oneLine, plural } from './common';

export function discussionLine(d: DiscussionSummary): string {
  const forumCmid = d.forumCmid !== null ? `, forum_cmid ${d.forumCmid}` : '';
  const ids = `forum_type ${d.forumType}, discussion_id ${d.discussionId}${forumCmid}`;
  const unread = d.unread ? `, ${d.unread} unread` : '';
  const where = `${oneLine(d.forumName, 50)} / ${oneLine(d.courseName, 50)}`;
  return `- ${d.pinned ? '[pinned] ' : ''}${oneLine(d.subject, 90)} — ${oneLine(d.author, 40)}, ${fmt(d.modifiedAt)} — ${plural(d.replies, 'reply', 'replies')}${unread} — ${where} (${ids})`;
}

export function renderDiscussions(r: { discussions: DiscussionSummary[]; skippedForums: number }): string {
  const footer =
    r.skippedForums > 0
      ? [`(${plural(r.skippedForums, 'forum')} not checked; pass course_id or forum_cmid to look at specific ones.)`]
      : [];
  if (r.discussions.length === 0) return ['No discussions found.', ...footer].join('\n');
  return assemble({
    head: [`${plural(r.discussions.length, 'discussion')} (newest first; open one with get_discussion):`],
    entries: r.discussions.map((d) => ({ text: discussionLine(d), item: true })),
    footer,
    hint: 'lower limit or pass course_id',
  });
}

/** hsuforum replies also need the discussion id (its preview cannot find a post without it). */
function replyHint(d: Discussion): string {
  if (!d.canReply) return 'Replying is not allowed in this discussion.';
  const s = d.summary;
  const extra = s.forumType === 'hsuforum' ? ` and discussion_id ${s.discussionId}` : '';
  return `You can reply: prepare_forum_post with reply_to_post_id set to the post_id${extra}.`;
}

export function renderDiscussion(d: Discussion): string {
  const s = d.summary;
  const head = [
    `# ${oneLine(s.subject, 120)} — ${s.forumType} discussion ${s.discussionId}`,
    `${oneLine(s.forumName, 60)}${s.courseName ? ` / ${oneLine(s.courseName, 60)}` : ''} · ${plural(d.posts.length, 'post')}`,
  ];
  const per = Math.max(350, Math.floor(2800 / Math.max(1, d.posts.length)));
  const blocks = d.posts.map((p) => {
    const parent = p.parentId !== null ? `, parent_id ${p.parentId}` : '';
    const lines = [`### ${oneLine(p.author, 50)} — ${fmt(p.createdAt)} (post_id ${p.id}${parent})`];
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

export function renderForumSearch(r: ForumSearchResult): string {
  const query = oneLine(r.query, 60);
  const found = r.hits.length > 0;
  const head = [
    found
      ? `${plural(r.hits.length, 'discussion')} matching "${query}" (best first; open one with get_discussion):`
      : `No discussions match "${query}" in the newest ${r.perForum} discussions of each forum.`,
  ];
  const footer = [
    ...(r.skippedForums > 0 ? [`(${plural(r.skippedForums, 'forum')} not searched; pass course_id to narrow.)`] : []),
    ...(r.messagesNote ? [`(${r.messagesNote})`] : []),
  ];
  const hits = r.hits.map((d) => ({ text: `${discussionLine(d)}\n  > ${oneLine(d.snippet, 180)}`, item: true }));
  return assemble({ head, entries: [...hits, ...messageEntries(r)], footer, hint: 'lower limit or pass course_id' });
}
