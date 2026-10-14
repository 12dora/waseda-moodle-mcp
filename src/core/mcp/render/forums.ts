import { fmt } from '../../time';
import type { Discussion, DiscussionSummary } from '../../types';
import { assemble, assembleTail, clip, fileLines, oneLine, plural } from './common';

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

export function renderDiscussion(d: Discussion): string {
  const s = d.summary;
  const head = [
    `# ${oneLine(s.subject, 120)} — ${s.forumType} discussion ${s.discussionId}`,
    `${oneLine(s.forumName, 60)}${s.courseName ? ` / ${oneLine(s.courseName, 60)}` : ''} · ${plural(d.posts.length, 'post')}`,
  ];
  const per = Math.max(350, Math.floor(2800 / Math.max(1, d.posts.length)));
  const blocks = d.posts.map((p) => {
    const lines = [`### ${oneLine(p.author, 50)} — ${fmt(p.createdAt)} (post_id ${p.id})`];
    if (p.subject && p.subject !== s.subject) lines.push(`Subject: ${oneLine(p.subject, 100)}`);
    lines.push(clip(p.message, per));
    if (p.attachments.length > 0) lines.push(...fileLines(p.attachments, 3));
    return lines.join('\n');
  });
  const footer = [
    d.canReply
      ? 'You can reply: prepare_forum_post with reply_to_post_id set to the post_id.'
      : 'Replying is not allowed in this discussion.',
  ];
  return assembleTail({ head, blocks, footer, noun: d.posts.length === 1 ? 'post' : 'posts' });
}
