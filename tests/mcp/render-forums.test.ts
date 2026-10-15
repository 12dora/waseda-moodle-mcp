import { describe, expect, it } from 'vitest';
import { renderDiscussion, renderForumSearch } from '../../src/core/mcp/render/forums';
import type { ForumSearchResult } from '../../src/core/services/forums-search';
import type { Discussion, DiscussionSummary } from '../../src/core/types';

const summary = (over: Partial<DiscussionSummary> = {}): DiscussionSummary => ({
  forumType: 'forum',
  forumId: 3001,
  forumCmid: 7010,
  forumName: 'Announcements',
  courseId: 9001,
  courseName: 'Corporate Finance Basics',
  discussionId: 701,
  firstPostId: 801,
  subject: 'Midterm exam room',
  author: 'Hanako Suzuki',
  createdAt: '2026-10-12T10:00:00+09:00',
  modifiedAt: '2026-10-14T10:00:00+09:00',
  replies: 1,
  unread: null,
  pinned: false,
  ...over,
});

const result = (over: Partial<ForumSearchResult> = {}): ForumSearchResult => ({
  query: 'midterm exam',
  hits: [{ ...summary(), snippet: 'The exam will be held in Room 301.', inSubject: true }],
  perForum: 30,
  skippedForums: 0,
  messages: null,
  messagesNote: null,
  ...over,
});

describe('renderForumSearch', () => {
  it('prints each hit with the ids needed for get_discussion and a snippet', () => {
    const t = renderForumSearch(result());
    expect(t).toContain('1 discussion matching "midterm exam"');
    expect(t).toContain('forum_type forum, discussion_id 701, forum_cmid 7010');
    expect(t).toContain('  > The exam will be held in Room 301.');
    expect(t).not.toContain('Messages');
  });

  it('says what was searched when nothing matches', () => {
    const t = renderForumSearch(result({ hits: [], skippedForums: 2 }));
    expect(t).toContain('No discussions match "midterm exam" in the newest 30 discussions of each forum.');
    expect(t).toContain('2 forums not searched; pass course_id to narrow.');
  });

  it('lists message hits with their ids and notes a skipped message search', () => {
    const t = renderForumSearch(
      result({
        messages: [
          {
            conversationId: 55,
            userId: 2002,
            name: 'Ken Sato',
            text: 'Can we meet?',
            sentAt: '2026-10-14T11:00:00+09:00',
            fromMe: false,
          },
          { conversationId: null, userId: 2003, name: 'Ann', text: 'ok', sentAt: null, fromMe: true },
        ],
      }),
    );
    expect(t).toContain('Messages (open with get_conversation, answer with prepare_message):');
    expect(t).toContain('"Can we meet?" (conversation_id 55, user_id 2002)');
    expect(t).toContain('Ann (you)');
    expect(t).toContain('"ok" (user_id 2003)');
    const skipped = renderForumSearch(result({ messages: [], messagesNote: 'Message search was skipped.' }));
    expect(skipped).toContain('(Message search was skipped.)');
    expect(skipped).not.toContain('No messages match.');
    expect(renderForumSearch(result({ messages: [] }))).toContain('No messages match.');
  });

  it('stays within the size cap', () => {
    const hits = Array.from({ length: 50 }, (_, i) => ({
      ...summary({ discussionId: i + 1 }),
      snippet: 'x'.repeat(300),
      inSubject: false,
    }));
    const t = renderForumSearch(result({ hits }));
    expect(t.length).toBeLessThanOrEqual(4200);
    expect(t).toMatch(/… \d+ more \(/);
  });
});

describe('renderDiscussion post ids', () => {
  const posts = [
    { id: 10, parentId: null, author: 'A', createdAt: null, subject: 'S', message: 'root', attachments: [] },
    { id: 11, parentId: 10, author: 'B', createdAt: null, subject: 'Re: S', message: 'reply', attachments: [] },
    { id: 12, parentId: 11, author: 'C', createdAt: null, subject: 'Re: S', message: 'nested', attachments: [] },
  ];
  const discussion = (type: 'forum' | 'hsuforum'): Discussion => ({
    summary: summary({ forumType: type, subject: 'S', discussionId: 77 }),
    posts,
    canReply: true,
  });

  it('shows the parent of nested replies', () => {
    const t = renderDiscussion(discussion('forum'));
    expect(t).toContain('(post_id 10)');
    expect(t).toContain('(post_id 11, parent_id 10)');
    expect(t).toContain('(post_id 12, parent_id 11)');
    expect(t).toContain('prepare_forum_post with reply_to_post_id set to the post_id.');
  });

  it('tells hsuforum replies to pass the discussion id', () => {
    expect(renderDiscussion(discussion('hsuforum'))).toContain('set to the post_id and discussion_id 77.');
  });
});
