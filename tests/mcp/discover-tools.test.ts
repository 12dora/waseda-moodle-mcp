import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import type { ToolDef } from '../../src/core/mcp/tools/define';
import { discoverTools } from '../../src/core/mcp/tools/discover';
import { searchCourses } from '../../src/core/services/discover/course-search';
import { listIncomplete } from '../../src/core/services/discover/incomplete';
import { listMyPosts } from '../../src/core/services/discover/my-posts';
import type { CourseSearchResult, IncompleteList, MyPostsList } from '../../src/core/services/discover/types';

vi.mock('../../src/core/services/discover/incomplete', () => ({ listIncomplete: vi.fn() }));
vi.mock('../../src/core/services/discover/my-posts', () => ({ listMyPosts: vi.fn() }));
vi.mock('../../src/core/services/discover/course-search', () => ({ searchCourses: vi.fn() }));

const ctx = { user: { id: 1 } } as unknown as ServiceContext;

const tool = (name: string): ToolDef => {
  const found = discoverTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

const INCOMPLETE: IncompleteList = {
  courses: [
    {
      courseId: 99101,
      courseName: '総合日本語３Ｘ',
      done: 3,
      total: 6,
      activities: [
        {
          cmid: 7101,
          name: 'オンデマンド動画１',
          kind: 'millvi',
          url: 'https://wsdmoodle.waseda.jp/mod/millvi/view.php?id=7101',
          sectionNumber: 1,
          sectionName: '第1回',
          completion: 'automatic',
          conditions: ['閲覧'],
          hidden: false,
        },
        {
          cmid: 7103,
          name: 'Handout',
          kind: 'resource',
          url: null,
          sectionNumber: 1,
          sectionName: '',
          completion: 'manual',
          conditions: [],
          hidden: true,
        },
      ],
    },
  ],
  skippedCourses: [
    { courseId: 99102, courseName: 'Example Course', reason: 'budget' },
    { courseId: 99103, courseName: 'Old Course', reason: 'unreadable' },
  ],
  kinds: null,
};

const POSTS: MyPostsList = {
  posts: [
    {
      postId: 7300002,
      discussionId: 9001,
      courseId: 99101,
      courseName: '総合日本語３Ｘ',
      forumType: 'forum',
      forumCmid: 7011,
      forumName: '自己紹介',
      discussionSubject: '自己紹介',
      postSubject: 'Re: 自己紹介',
      postedAt: '2026-11-26T09:30:00+09:00',
      isDiscussionStart: false,
      parentPostId: 7290000,
      replies: null,
      excerpt: '返信です',
      url: 'https://wsdmoodle.waseda.jp/mod/forum/discuss.php?d=9001#p7300002',
    },
  ],
  page: 0,
  nextPage: 1,
};

const SEARCH: CourseSearchResult = {
  query: 'seminar',
  courses: [
    {
      id: 99103,
      name: 'Example Seminar',
      shortName: 'ES',
      category: 'Law',
      url: 'https://wsdmoodle.waseda.jp/course/view.php?id=99103',
      enrolled: false,
    },
  ],
  total: 21,
  page: 0,
  pageSize: 20,
  nextPage: 1,
};

beforeEach(() => {
  vi.mocked(listIncomplete).mockReset();
  vi.mocked(listMyPosts).mockReset();
  vi.mocked(searchCourses).mockReset();
});

describe('discoverTools', () => {
  it('exports the three read-only tools under stable names', () => {
    expect(discoverTools.map((t) => t.name)).toEqual(['list_incomplete', 'list_my_posts', 'search_courses']);
    for (const t of discoverTools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('list_incomplete passes its arguments on and shows conditions, counts and skipped courses', async () => {
    vi.mocked(listIncomplete).mockResolvedValue(INCOMPLETE);
    const def = tool('list_incomplete');
    const args = def.input.parse({ course_id: 99101, kinds: ['millvi'], include_hidden: true });
    const out = await def.run(ctx, args);
    expect(listIncomplete).toHaveBeenCalledWith(ctx, { courseId: 99101, kinds: ['millvi'], includeHidden: true });
    expect(def.output.safeParse(JSON.parse(JSON.stringify(out.data))).success).toBe(true);
    expect(out.text).toContain('2 activities not done in 1 course');
    expect(out.text).toContain('3/6 done');
    expect(out.text).toContain('[on-demand video] オンデマンド動画１ (cmid 7101) — to do: 閲覧 — 第1回');
    expect(out.text).toContain('[resource] Handout (cmid 7103) — to do: mark as done — hidden or not available yet');
    expect(out.text).toContain('repeat with course_id): Example Course (99102)');
    expect(out.text).toContain('Could not be read: Old Course (99103)');
  });

  it('list_incomplete says so when everything is done', async () => {
    vi.mocked(listIncomplete).mockResolvedValue({ courses: [], skippedCourses: [], kinds: ['millvi'] });
    const def = tool('list_incomplete');
    const out = await def.run(ctx, def.input.parse({}));
    expect(out.text).toContain('Nothing left to do of kind on-demand video');
    expect(def.input.safeParse({ kinds: Array.from({ length: 11 }, () => 'quiz') }).success).toBe(false);
    expect(def.input.safeParse({ course_id: 0 }).success).toBe(false);
  });

  it('list_my_posts renders reply and start posts and points to the next page', async () => {
    vi.mocked(listMyPosts).mockResolvedValue(POSTS);
    const def = tool('list_my_posts');
    const out = await def.run(ctx, def.input.parse({ page: 0 }));
    expect(listMyPosts).toHaveBeenCalledWith(ctx, { courseId: undefined, page: 0 });
    expect(def.output.safeParse(JSON.parse(JSON.stringify(out.data))).success).toBe(true);
    expect(out.text).toContain('2026-11-26 Thu 09:30 — reply: Re: 自己紹介');
    expect(out.text).toContain('総合日本語３Ｘ > 自己紹介 > 自己紹介 (discussion_id 9001, post_id 7300002)');
    expect(out.text).toContain('call again with page 1');
  });

  it('list_my_posts words an empty first page and an empty later page differently', async () => {
    const def = tool('list_my_posts');
    vi.mocked(listMyPosts).mockResolvedValueOnce({ posts: [], page: 0, nextPage: null });
    expect((await def.run(ctx, def.input.parse({}))).text).toBe('You have no forum posts in this selection.');
    vi.mocked(listMyPosts).mockResolvedValueOnce({ posts: [], page: 3, nextPage: null });
    expect((await def.run(ctx, def.input.parse({ page: 3 }))).text).toBe('No posts on page 3.');
  });

  it('search_courses shows enrolment per course and the paging hint', async () => {
    vi.mocked(searchCourses).mockResolvedValue(SEARCH);
    const def = tool('search_courses');
    const out = await def.run(ctx, def.input.parse({ query: ' seminar ' }));
    expect(searchCourses).toHaveBeenCalledWith(ctx, 'seminar', { page: undefined });
    expect(def.output.safeParse(JSON.parse(JSON.stringify(out.data))).success).toBe(true);
    expect(out.text).toContain('21 courses match "seminar" (page 0)');
    expect(out.text).toContain('Example Seminar [ES] — course_id 99103 — Law — not enrolled');
    expect(out.text).toContain('call again with page 1');
    vi.mocked(searchCourses).mockResolvedValue({ ...SEARCH, courses: [], total: 0, nextPage: null });
    expect((await def.run(ctx, def.input.parse({ query: 'seminar' }))).text).toBe('No courses match "seminar".');
  });
});
