import { describe, expect, it } from 'vitest';
import { InvalidInput, MoodleError } from '../../src/core/errors';
import { listMyPosts } from '../../src/core/services/discover/my-posts';
import { parsePostsPage } from '../../src/core/services/discover/posts-page';
import { makeFakeContext } from '../helpers/fake-context-be3';
import { createTestContext } from '../helpers/fake-context-be4';
import { fixture, makeWebApi } from './web-channel';

const BASE = 'https://wsdmoodle.waseda.jp';

describe('parsePostsPage', () => {
  const page = parsePostsPage(fixture('my-posts-ja.html'));

  it('reads one entry per post from the links, the time value and the post box', () => {
    expect(page.posts).toHaveLength(3);
    expect(page.posts[0]).toEqual({
      postId: 7300003,
      discussionId: 9003,
      courseId: 99101,
      courseName: '総合日本語３Ｘ',
      forumType: 'forum',
      forumCmid: 7011,
      forumName: '自己紹介',
      discussionSubject: 'はじめまして',
      postSubject: 'はじめまして',
      postedAt: '2026-11-27T11:56:55+09:00',
      isDiscussionStart: true,
      parentPostId: null,
      replies: null,
      excerpt: '山田です。よろしくお願いします。',
      url: `${BASE}/mod/forum/discuss.php?d=9003#p7300003`,
    });
  });

  it('tells a reply by the parent link and takes its own subject from the post box label', () => {
    expect(page.posts[1]).toMatchObject({
      postId: 7300002,
      discussionId: 9001,
      isDiscussionStart: false,
      parentPostId: 7290000,
      discussionSubject: '自己紹介',
      postSubject: 'Re: 自己紹介',
      excerpt: '返信です & 質問があります。',
    });
    expect(page.posts[2]).toMatchObject({
      courseId: 99102,
      forumCmid: 7021,
      discussionSubject: 'Question about the midterm',
    });
  });

  it('reads the pager: the pages it links to and the page size it states', () => {
    expect(page.linkedPages).toEqual([1, 2]);
    expect(page.pageSize).toBe(20);
  });

  it('gives empty lists for a page without posts or without a pager', () => {
    expect(parsePostsPage(fixture('my-posts-empty-ja.html'))).toEqual({ posts: [], linkedPages: [], pageSize: null });
    expect(parsePostsPage('<div id="region-main"><p>none</p></div>')).toEqual({
      posts: [],
      linkedPages: [],
      pageSize: null,
    });
  });

  it('skips an article without a discussion link instead of guessing', () => {
    const heading = '<h3 data-region-content="forum-post-core-subject"></h3>';
    expect(parsePostsPage(`<article data-region="post" data-post-id="5">${heading}</article>`).posts).toEqual([]);
  });
});

function webContext(pages: Record<string, string>) {
  const api = makeWebApi({ pages });
  return { ctx: { ...createTestContext().ctx, moodle: async () => api }, api };
}

describe('listMyPosts', () => {
  it('reads the first page of the user listing in one request and names the next page', async () => {
    const { ctx, api } = webContext({ '/mod/forum/user.php?id=7001&perpage=20': fixture('my-posts-ja.html') });
    const r = await listMyPosts(ctx);
    expect(api.pageCalls).toEqual(['GET /mod/forum/user.php?id=7001&perpage=20']);
    expect(r.posts.map((p) => p.postId)).toEqual([7300003, 7300002, 7300001]);
    expect(r).toMatchObject({ page: 0, nextPage: 1 });
  });

  it('passes the course and page, and ends on the last page', async () => {
    const path = '/mod/forum/user.php?id=7001&course=99102&perpage=20&page=2';
    const { ctx, api } = webContext({ [path]: fixture('my-posts-last-ja.html') });
    const r = await listMyPosts(ctx, { courseId: 99102, page: 2 });
    expect(api.pageCalls).toEqual([`GET ${path}`]);
    expect(r).toMatchObject({ page: 2, nextPage: null });
    expect(r.posts).toHaveLength(1);
  });

  it('answers an empty list for a user without posts', async () => {
    const { ctx } = webContext({ '/mod/forum/user.php?id=7001&perpage=20': fixture('my-posts-empty-ja.html') });
    expect(await listMyPosts(ctx)).toEqual({ posts: [], page: 0, nextPage: null });
  });

  it('lets a Moodle refusal through and rejects a bad course id', async () => {
    const api = makeWebApi({});
    const ctx = { ...createTestContext().ctx, moodle: async () => api };
    await expect(listMyPosts(ctx)).rejects.toBeInstanceOf(MoodleError);
    await expect(listMyPosts(ctx, { courseId: -1 })).rejects.toBeInstanceOf(InvalidInput);
  });

  it('is not available on the web-service channel', async () => {
    const { ctx } = makeFakeContext({});
    await expect(listMyPosts(ctx)).rejects.toMatchObject({ code: 'servicenotavailable' });
  });
});
