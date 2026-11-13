import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import type { ToolDef } from '../../src/core/mcp/tools/define';
import { searchTools } from '../../src/core/mcp/tools/search';
import { socialTools } from '../../src/core/mcp/tools/social';
import { writeTools } from '../../src/core/mcp/tools/write';
import { prepareForumPost, prepareForumPostChange, prepareForumSubscription } from '../../src/core/services/actions';
import { getDiscussion } from '../../src/core/services/forums';
import { listDiscussions } from '../../src/core/services/forums-list';
import { searchForums } from '../../src/core/services/forums-search';

vi.mock('../../src/core/services/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/services/actions')>()),
  prepareForumPost: vi.fn(),
  prepareForumPostChange: vi.fn(),
  prepareForumSubscription: vi.fn(),
}));
vi.mock('../../src/core/services/forums-search', () => ({ searchForums: vi.fn() }));
vi.mock('../../src/core/services/forums', () => ({
  getDiscussion: vi.fn(),
}));
vi.mock('../../src/core/services/forums-list', () => ({
  listDiscussions: vi.fn(),
}));

const ctx = { user: { id: 1 } } as unknown as ServiceContext;
const preview = {
  actionId: 'act_1',
  kind: 'forum_subscription' as const,
  title: 'Subscribe',
  details: [],
  warnings: [],
  expiresAt: '2026-10-14T12:30:00+09:00',
  approval: 'chat' as const,
  approveUrl: null,
};

const tool = (list: readonly ToolDef[], name: string): ToolDef => {
  const found = list.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

beforeEach(() => {
  vi.mocked(prepareForumPost).mockReset();
  vi.mocked(prepareForumPostChange).mockReset();
  vi.mocked(prepareForumSubscription).mockReset();
  vi.mocked(searchForums).mockReset();
  vi.mocked(listDiscussions).mockReset();
  vi.mocked(getDiscussion).mockReset();
});

describe('list_discussions / get_discussion tools', () => {
  it('list_discussions maps page and mentions how to start a discussion', async () => {
    const t = tool(socialTools, 'list_discussions');
    expect(t.description).toContain('prepare_forum_post with forum_id');
    expect(t.description).toContain('current courses');
    expect(t.description).toContain('can post');
    expect(t.description).toContain('forum_type hsuforum for Advanced Forum');
    expect(t.description).toContain('same limit');
    vi.mocked(listDiscussions).mockResolvedValue({
      forums: [],
      discussions: [],
      skippedForums: 0,
      truncatedForums: [],
    });
    const args = t.input.parse({ forum_cmid: 7010, page: 1, limit: 20 });
    await t.run(ctx, args);
    expect(listDiscussions).toHaveBeenCalledWith(ctx, {
      courseId: undefined,
      forumCmid: 7010,
      sinceDays: undefined,
      limit: 20,
      page: 1,
    });
    expect(t.input.safeParse({ page: 1 }).success).toBe(true);
  });

  it('get_discussion maps post_id and mentions reply vs start', async () => {
    const t = tool(socialTools, 'get_discussion');
    expect(t.description).toContain('prepare_forum_post with the post_id');
    expect(t.description).toContain('prepare_forum_post with the forum_id');
    expect(t.description).toContain('not a post id');
    expect(t.description).toContain('forum_type hsuforum');
    vi.mocked(getDiscussion).mockResolvedValue({
      summary: {
        forumType: 'forum',
        forumId: 7,
        forumCmid: 8,
        forumName: 'Q&A',
        forumKind: 'general',
        courseId: 99,
        courseName: 'C',
        discussionId: 1,
        firstPostId: 2,
        subject: 'S',
        author: 'A',
        createdAt: null,
        modifiedAt: null,
        replies: 0,
        unread: null,
        pinned: false,
        canCreateDiscussions: true,
        dueAt: null,
        cutoffAt: null,
      },
      posts: [
        {
          id: 2,
          parentId: null,
          author: 'A',
          createdAt: null,
          subject: 'S',
          message: 'Hi',
          attachments: [],
          unread: false,
          canReply: true,
        },
      ],
      canReply: true,
      forumIntro: '',
    });
    const args = t.input.parse({ forum_type: 'forum', discussion_id: 1, post_id: 2 });
    await t.run(ctx, args);
    expect(getDiscussion).toHaveBeenCalledWith(ctx, {
      forumType: 'forum',
      discussionId: 1,
      forumCmid: undefined,
      postId: 2,
    });
  });
});

describe('search_forums tool', () => {
  const search = tool(searchTools, 'search_forums');

  it('maps its input and renders the result', async () => {
    vi.mocked(searchForums).mockResolvedValue({
      query: 'exam',
      hits: [],
      perForum: 30,
      skippedForums: 0,
      messages: null,
      messagesNote: null,
    });
    const args = search.input.parse({ query: ' exam room ', course_id: 9001, include_messages: true, limit: 5 });
    const out = await search.run(ctx, args);
    expect(searchForums).toHaveBeenCalledWith(ctx, {
      query: 'exam room',
      courseId: 9001,
      includeMessages: true,
      limit: 5,
    });
    expect(out.text).toContain('No discussions match "exam"');
    expect(out.data).toMatchObject({ query: 'exam' });
  });

  it('rejects empty and oversized queries', () => {
    expect(search.input.safeParse({ query: '   ' }).success).toBe(false);
    expect(search.input.safeParse({ query: 'x'.repeat(201) }).success).toBe(false);
    expect(search.input.safeParse({ query: 'x', limit: 51 }).success).toBe(false);
  });
});

describe('write tools', () => {
  it('prepare_forum_post passes discussion_id to the service', async () => {
    vi.mocked(prepareForumPost).mockResolvedValue({ ...preview, kind: 'forum_reply' });
    const t = tool(writeTools(false), 'prepare_forum_post');
    const args = t.input.parse({ forum_type: 'hsuforum', reply_to_post_id: 7, discussion_id: 55, message: 'Thanks' });
    await t.run(ctx, args);
    expect(prepareForumPost).toHaveBeenCalledWith(ctx, {
      forumType: 'hsuforum',
      replyToPostId: 7,
      forumId: undefined,
      discussionId: 55,
      forumCmid: undefined,
      subject: undefined,
      message: 'Thanks',
      files: undefined,
      uploadId: undefined,
      discussionSubscribe: undefined,
    });
  });

  it('prepare_forum_post maps attachments and the subscription choice', async () => {
    vi.mocked(prepareForumPost).mockResolvedValue({ ...preview, kind: 'forum_discussion' });
    const t = tool(writeTools(false), 'prepare_forum_post');
    const args = t.input.parse({
      forum_type: 'forum',
      forum_id: 3001,
      subject: 'Intro',
      message: 'Hello',
      files: [{ name: 'a.txt', text: 'x' }],
      upload_id: 'upl_1',
      discussion_subscribe: false,
    });
    await t.run(ctx, args);
    expect(prepareForumPost).toHaveBeenCalledWith(ctx, {
      forumType: 'forum',
      replyToPostId: undefined,
      forumId: 3001,
      discussionId: undefined,
      forumCmid: undefined,
      subject: 'Intro',
      message: 'Hello',
      files: [{ name: 'a.txt', text: 'x' }],
      uploadId: 'upl_1',
      discussionSubscribe: false,
    });
  });

  it('offers local paths and no upload_id in stdio mode', () => {
    const t = tool(writeTools(true), 'prepare_forum_post');
    const parsed = t.input.parse({
      forum_type: 'forum',
      forum_id: 1,
      subject: 's',
      message: 'm',
      files: [{ name: 'a.pdf', path: '/tmp/a.pdf' }],
      upload_id: 'upl_1',
    }) as Record<string, unknown>;
    expect(parsed.files).toEqual([{ name: 'a.pdf', path: '/tmp/a.pdf' }]);
    expect(parsed.upload_id).toBeUndefined();
  });

  it('prepare_forum_post_change maps edit and delete', async () => {
    vi.mocked(prepareForumPostChange).mockResolvedValue({ ...preview, kind: 'forum_post_edit' });
    const t = tool(writeTools(false), 'prepare_forum_post_change');
    const args = { forum_cmid: 7010, post_id: 77, action: 'edit', message: 'Fixed', keep_existing_files: false };
    await t.run(ctx, t.input.parse(args));
    expect(prepareForumPostChange).toHaveBeenCalledWith(ctx, {
      forumCmid: 7010,
      postId: 77,
      action: 'edit',
      subject: undefined,
      message: 'Fixed',
      files: undefined,
      uploadId: undefined,
      keepExistingFiles: false,
      discussionSubscribe: undefined,
    });
    expect(t.input.safeParse({ forum_cmid: 7010, post_id: 77, action: 'remove' }).success).toBe(false);
    expect(t.input.safeParse({ post_id: 77, action: 'delete' }).success).toBe(false);
  });

  it('prepare_forum_subscription maps its input', async () => {
    vi.mocked(prepareForumSubscription).mockResolvedValue(preview);
    const t = tool(writeTools(false), 'prepare_forum_subscription');
    const out = await t.run(ctx, t.input.parse({ forum_cmid: 7010, subscribe: false }));
    expect(prepareForumSubscription).toHaveBeenCalledWith(ctx, { forumCmid: 7010, subscribe: false });
    expect(out.data).toMatchObject({ actionId: 'act_1' });
    expect(t.input.safeParse({ forum_cmid: 7010 }).success).toBe(false);
  });
});
