import { describe, expect, it } from 'vitest';
import { renderDiscussion, renderDiscussions, renderForumSearch } from '../../src/core/mcp/render/forums';
import type { ForumSearchResult } from '../../src/core/services/forums-search';
import type { Discussion, DiscussionSummary, ForumListEntry } from '../../src/core/types';

const summary = (over: Partial<DiscussionSummary> = {}): DiscussionSummary => ({
  forumType: 'forum',
  forumId: 3001,
  forumCmid: 7010,
  forumName: 'Announcements',
  forumKind: 'news',
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
  canCreateDiscussions: false,
  dueAt: null,
  cutoffAt: null,
  ...over,
});

const forumEntry = (over: Partial<ForumListEntry> = {}): ForumListEntry => ({
  forumType: 'forum',
  forumId: 3001,
  forumCmid: 7010,
  forumName: 'Q&A',
  forumKind: 'general',
  courseId: 9001,
  courseName: 'Corporate Finance Basics',
  canCreateDiscussions: true,
  dueAt: null,
  cutoffAt: null,
  numDiscussions: 0,
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
    expect(t).toContain('forum_id 3001, discussion_id 701, cmid 7010');
    expect(t).toContain('Announcements (announcements) / Corporate Finance Basics');
    expect(t).not.toContain('forum_type forum');
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
    {
      id: 10,
      parentId: null,
      author: 'A',
      createdAt: null,
      subject: 'S',
      message: 'root',
      attachments: [],
      unread: false,
      canReply: true,
    },
    {
      id: 11,
      parentId: 10,
      author: 'B',
      createdAt: null,
      subject: 'Re: S',
      message: 'reply',
      attachments: [],
      unread: true,
      canReply: true,
    },
    {
      id: 12,
      parentId: 11,
      author: 'C',
      createdAt: null,
      subject: 'Re: S',
      message: 'nested',
      attachments: [],
      unread: false,
      canReply: false,
    },
  ];
  const discussion = (type: 'forum' | 'hsuforum'): Discussion => ({
    summary: summary({
      forumType: type,
      subject: 'S',
      discussionId: 77,
      forumKind: 'general',
      canCreateDiscussions: true,
    }),
    posts,
    canReply: true,
    forumIntro: 'Please post in this thread.',
  });

  it('shows the parent of nested replies', () => {
    const t = renderDiscussion(discussion('forum'));
    expect(t).toContain('(post_id 10, can reply)');
    expect(t).toContain('(post_id 11, parent_id 10, unread, can reply)');
    expect(t).toContain('(post_id 12, parent_id 11, cannot reply)');
    expect(t).toContain('You can reply to post_id 10, 11: prepare_forum_post with reply_to_post_id.');
    expect(t).not.toContain('set to the post_id.');
    expect(t).toContain('Please post in this thread.');
    expect(t).toContain('general discussion 77');
    expect(t).not.toContain('forum_type forum');
    expect(t).not.toContain('Advanced Forum');
    expect(t).toContain('forum_id 3001, cmid 7010');
    expect(t).toContain('prepare_forum_post with forum_id 3001');
  });

  it('tells hsuforum replies to pass the discussion id', () => {
    const t = renderDiscussion(discussion('hsuforum'));
    expect(t).toContain(
      'You can reply to post_id 10, 11: prepare_forum_post with reply_to_post_id and discussion_id 77.',
    );
    expect(t).toContain('general Advanced Forum discussion 77');
  });

  it('names the replyable post when it is omitted from the text', () => {
    const later = Array.from({ length: 12 }, (_, i) => ({
      id: 2 + i,
      parentId: 1,
      author: 'B',
      createdAt: null,
      subject: 'Re: S',
      message: `later ${i} ${'word '.repeat(80)}`,
      attachments: [],
      unread: false,
      canReply: false,
    }));
    const t = renderDiscussion({
      summary: summary({ subject: 'S', discussionId: 77, forumKind: 'general' }),
      posts: [
        {
          id: 1,
          parentId: null,
          author: 'A',
          createdAt: null,
          subject: 'S',
          message: 'root',
          attachments: [],
          unread: false,
          canReply: true,
        },
        ...later,
      ],
      canReply: true,
      forumIntro: '',
    });
    expect(t).toMatch(/… \d+ earlier posts omitted/);
    expect(t).not.toContain('(post_id 1,');
    expect(t).toContain('cannot reply');
    expect(t).toContain('You can reply to post_id 1:');
    expect(t).not.toContain('set to the post_id.');
  });
});

describe('renderDiscussions grouping', () => {
  it('prints forum_id, type, posting flag, due date and a paging hint', () => {
    const t = renderDiscussions({
      forums: [],
      discussions: [
        summary({
          forumKind: 'general',
          canCreateDiscussions: true,
          dueAt: '2026-11-03T18:43:00+09:00',
        }),
      ],
      skippedForums: 0,
      truncatedForums: [
        {
          forumType: 'forum',
          forumId: 3001,
          forumCmid: 7010,
          forumName: 'Announcements',
          remaining: 21,
          nextPage: 1,
          pageSize: 10,
        },
      ],
    });
    expect(t).toContain(
      'Announcements — Corporate Finance Basics, general, can post, due 2026-11-03 Tue 18:43 (forum_id 3001, cmid 7010)',
    );
    expect(t).toContain('To start a discussion, prepare_forum_post with forum_id.');
    expect(t).not.toContain('prepare_forum_post with forum_id)');
    expect(t).not.toContain('forum_type forum');
    const disc = t.split('\n').find((line) => line.startsWith('- Midterm'));
    expect(disc).toBe('- Midterm exam room — Hanako Suzuki, 2026-10-14 Wed 10:00 — 1 reply (discussion_id 701)');
    expect(t).toContain('21 more; pass forum_cmid 7010, page 1, limit 10');
  });

  it('names Advanced Forum only for hsuforum and does not repeat the header on discussion lines', () => {
    const t = renderDiscussions({
      forums: [],
      discussions: [
        summary({ forumType: 'hsuforum', forumKind: 'blog', forumName: 'Weekly', canCreateDiscussions: true }),
        summary({
          forumType: 'hsuforum',
          forumKind: 'blog',
          forumName: 'Weekly',
          discussionId: 702,
          subject: 'Week 2',
          canCreateDiscussions: true,
        }),
      ],
      skippedForums: 0,
      truncatedForums: [],
    });
    expect(t).toContain('Weekly — Corporate Finance Basics, blog, Advanced Forum, can post (forum_id 3001, cmid 7010)');
    expect(t.split('Advanced Forum').length - 1).toBe(1);
    expect(t).toContain('(discussion_id 701)');
    expect(t).toContain('(discussion_id 702)');
    expect(t).not.toContain('forum_id 3001, discussion_id');
  });

  it('lists an empty postable forum without a second empty-state sentence', () => {
    const t = renderDiscussions({
      forums: [forumEntry()],
      discussions: [],
      skippedForums: 0,
      truncatedForums: [],
    });
    expect(t).toContain('Q&A — Corporate Finance Basics, general, can post (forum_id 3001, cmid 7010)');
    expect(t).toContain('No discussions yet.');
    expect(t).toContain('To start a discussion, prepare_forum_post with forum_id.');
    expect(t).not.toContain('No discussions found.');
  });

  it('says no discussions match when a nonempty forum is filtered or paged to empty', () => {
    const filtered = renderDiscussions({
      forums: [forumEntry({ numDiscussions: 5 })],
      discussions: [],
      skippedForums: 0,
      truncatedForums: [],
    });
    expect(filtered).toContain('No discussions match this page or filter.');
    expect(filtered).not.toContain('No discussions yet.');
    const paged = renderDiscussions({
      forums: [forumEntry({ forumName: 'Busy', numDiscussions: 31 })],
      discussions: [],
      skippedForums: 0,
      truncatedForums: [],
    });
    expect(paged).toContain('No discussions match this page or filter.');
    expect(paged).not.toContain('No discussions yet.');
  });

  it('says the forum could not be read when a single forum was skipped', () => {
    const t = renderDiscussions({
      forums: [forumEntry({ numDiscussions: 4 })],
      discussions: [],
      skippedForums: 1,
      truncatedForums: [],
    });
    expect(t).toContain('This forum could not be read.');
    expect(t).not.toContain('No discussions yet.');
  });

  it('prints a continuation for a forum omitted by the global limit', () => {
    const t = renderDiscussions({
      forums: [
        forumEntry({ forumName: 'A', numDiscussions: 10 }),
        forumEntry({ forumId: 3002, forumCmid: 7011, forumName: 'B', numDiscussions: 5 }),
      ],
      discussions: [summary({ forumKind: 'general', forumName: 'A', canCreateDiscussions: true })],
      skippedForums: 0,
      truncatedForums: [
        {
          forumType: 'forum',
          forumId: 3002,
          forumCmid: 7011,
          forumName: 'B',
          remaining: 5,
          nextPage: 0,
          pageSize: 10,
        },
      ],
    });
    expect(t).toContain('A — Corporate Finance Basics, general, can post (forum_id 3001, cmid 7010)');
    expect(t).toContain('B — Corporate Finance Basics, general, can post (forum_id 3002, cmid 7011)');
    expect(t).toContain('5 more; pass forum_cmid 7011, page 0, limit 10');
  });

  it('prints a continuation for an omitted Advanced Forum that shares an id with a listed forum', () => {
    const t = renderDiscussions({
      forums: [
        forumEntry({ forumName: 'Q&A', numDiscussions: 10 }),
        forumEntry({
          forumType: 'hsuforum',
          forumId: 3001,
          forumCmid: 8010,
          forumName: 'Weekly',
          numDiscussions: 5,
        }),
      ],
      discussions: [summary({ forumKind: 'general', forumName: 'Q&A', canCreateDiscussions: true })],
      skippedForums: 0,
      truncatedForums: [
        {
          forumType: 'hsuforum',
          forumId: 3001,
          forumCmid: 8010,
          forumName: 'Weekly',
          remaining: 5,
          nextPage: 0,
          pageSize: 10,
        },
      ],
    });
    expect(t).toContain('Q&A — Corporate Finance Basics, general, can post (forum_id 3001, cmid 7010)');
    expect(t).toContain(
      'Weekly — Corporate Finance Basics, general, Advanced Forum, can post (forum_id 3001, cmid 8010)',
    );
    expect(t).toContain('5 more; pass forum_cmid 8010, page 0, limit 10');
  });
});
