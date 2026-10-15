import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import type { ToolDef } from '../../src/core/mcp/tools/define';
import { searchTools } from '../../src/core/mcp/tools/search';
import { writeTools } from '../../src/core/mcp/tools/write';
import { prepareForumPost, prepareForumSubscription } from '../../src/core/services/actions';
import { searchForums } from '../../src/core/services/forums-search';

vi.mock('../../src/core/services/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/services/actions')>()),
  prepareForumPost: vi.fn(),
  prepareForumSubscription: vi.fn(),
}));
vi.mock('../../src/core/services/forums-search', () => ({ searchForums: vi.fn() }));

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
  vi.mocked(prepareForumSubscription).mockReset();
  vi.mocked(searchForums).mockReset();
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
    const t = tool(writeTools, 'prepare_forum_post');
    const args = t.input.parse({ forum_type: 'hsuforum', reply_to_post_id: 7, discussion_id: 55, message: 'Thanks' });
    await t.run(ctx, args);
    expect(prepareForumPost).toHaveBeenCalledWith(ctx, {
      forumType: 'hsuforum',
      replyToPostId: 7,
      forumId: undefined,
      discussionId: 55,
      subject: undefined,
      message: 'Thanks',
    });
  });

  it('prepare_forum_subscription maps its input', async () => {
    vi.mocked(prepareForumSubscription).mockResolvedValue(preview);
    const t = tool(writeTools, 'prepare_forum_subscription');
    const out = await t.run(ctx, t.input.parse({ forum_cmid: 7010, subscribe: false }));
    expect(prepareForumSubscription).toHaveBeenCalledWith(ctx, { forumCmid: 7010, subscribe: false });
    expect(out.data).toMatchObject({ actionId: 'act_1' });
    expect(t.input.safeParse({ forum_cmid: 7010 }).success).toBe(false);
  });
});
