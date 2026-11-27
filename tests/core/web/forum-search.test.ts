import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MoodleError } from '../../../src/core/errors';
import { parseForumSearch, searchCourses } from '../../../src/core/moodle/web/parse/forum-search';
import { makeFakeWebSession } from '../../helpers/fake-web-session';

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/web/${name}`, import.meta.url), 'utf8');
const PAGE1 = fixture('forum-search-ja.html');
const PAGE2 = fixture('forum-search-page2-ja.html');
const EMPTY = fixture('forum-search-empty-ja.html');

const seconds = (iso: string) => Date.parse(iso) / 1000;
const QUERY = encodeURIComponent('レポート');
const path = (course: number, page = 0) =>
  `/mod/forum/search.php?id=${course}&search=${QUERY}&perpage=20${page ? `&page=${page}` : ''}`;

describe('parseForumSearch', () => {
  it('reads each result post: forum, discussion, parent, author, time, message', () => {
    const { posts, hasNextPage } = parseForumSearch(PAGE1);
    expect(hasNextPage).toBe(true);
    expect(posts.map((p) => p.postId)).toEqual([6003, 6001, 6010]);
    expect(posts[0]).toEqual({
      postId: 6003,
      discussionId: 5001,
      parentId: 6001,
      forumCmid: 7002,
      forumName: '質問コーナー',
      discussionName: '期末レポートについて',
      subject: 'Re: 期末レポートについて',
      author: '鈴木花子',
      authorId: 7102,
      time: seconds('2026-11-20T10:38:31+09:00'),
      message: expect.stringContaining('<span class="highlight">レポート</span>の長さ'),
      unread: true,
    });
    expect(posts[1]).toMatchObject({
      postId: 6001,
      discussionId: 5001,
      parentId: null,
      author: '山田太郎',
      unread: false,
    });
    expect(posts[2]).toMatchObject({ discussionId: 5002, forumCmid: 7003, forumName: '自由掲示板', authorId: 7103 });
  });

  it('sees no next page on the last page and no posts when nothing matches', () => {
    const last = parseForumSearch(PAGE2);
    expect(last.hasNextPage).toBe(false);
    expect(last.posts).toHaveLength(1);
    expect(parseForumSearch(EMPTY)).toEqual({ posts: [], hasNextPage: false });
  });
});

describe('searchCourses', () => {
  const run = (opts: { left: number; enough?: boolean; refuse?: number }) => {
    const refused = () => {
      throw new MoodleError('No access.', 'nopermissions');
    };
    const web = makeFakeWebSession({
      pages: {
        [path(99101)]: PAGE1,
        [path(99101, 1)]: PAGE2,
        [path(99102)]: opts.refuse === 99102 ? refused : EMPTY,
        [path(99103)]: EMPTY,
      },
    });
    return searchCourses(web, {
      courseIds: [99101, 99102, 99103],
      query: 'レポート',
      perPage: 20,
      maxPages: 2,
      callsLeft: () => opts.left,
      enough: () => opts.enough === true,
    }).then((r) => ({ ...r, calls: web.calls }));
  };

  it('reads page 1 of each course, then page 2 of the courses that have more', async () => {
    const r = await run({ left: 10 });
    const gets = [path(99101), path(99102), path(99103), path(99101, 1)].map((p) => `GET ${p}`);
    expect(r.calls).toEqual(gets);
    expect(r.pages.flatMap((p) => p.posts.map((x) => x.postId))).toEqual([6003, 6001, 6010, 5990]);
    expect(r).toMatchObject({ skipped: 0, cut: 0 });
  });

  it('stops after page 1 when enough matched and counts the courses left with more', async () => {
    const r = await run({ left: 10, enough: true });
    expect(r.calls).toHaveLength(3);
    expect(r).toMatchObject({ skipped: 0, cut: 1 });
  });

  it('skips the courses over the call budget and those Moodle refuses', async () => {
    const tight = await run({ left: 1 });
    expect(tight.calls).toEqual([`GET ${path(99101)}`, `GET ${path(99101, 1)}`]);
    expect(tight.skipped).toBe(2);
    const refused = await run({ left: 10, refuse: 99102 });
    expect(refused.skipped).toBe(1);
    expect(refused.pages.find((p) => p.courseId === 99102)).toMatchObject({ failed: true, posts: [] });
  });
});
