import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, NotFound } from '../../src/core/errors';
import { listAllCourses, listCourses } from '../../src/core/services/courses';
import {
  getDiscussion,
  mapDiscussion,
  mapForumRef,
  type RawDiscussionList,
  type RawForum,
} from '../../src/core/services/forums';
import { listDiscussions } from '../../src/core/services/forums-list';
import { clampInt, cleanFileUrl, pickLang } from '../../src/core/services/shared';
import type { Course } from '../../src/core/types';
import {
  forumDiscussions,
  forumDiscussionsC2,
  forumPosts,
  forumsC1,
  forumsC2,
  hsuAnonDiscussions,
  hsuAnonForum,
  hsuDiscussions,
  hsuForumsC1,
  hsuPosts,
} from '../fixtures/be3/forums';
import { countCalls, FAKE_BASE_URL, makeFakeContext } from '../helpers/fake-context-be3';

vi.mock('../../src/core/services/courses', () => {
  const inprogress = [
    { id: 9001, name: 'Corporate Finance Basics' },
    { id: 9002, name: 'Seminar & Lab' },
  ];
  return {
    listCourses: vi.fn(async () => inprogress),
    listAllCourses: vi.fn(async () => [...inprogress, { id: 9003, name: 'Archive' }]),
  };
});

// 2026-10-14 12:00 JST
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00+09:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

const forumsFor = (list: RawForum[]) => (p: Record<string, unknown>) =>
  list.filter((f) => (p.courseids as number[]).includes(f.course));
const discussionsBy = (byForum: Record<number, RawDiscussionList>) => (p: Record<string, unknown>) =>
  byForum[p.forumid as number] ?? { discussions: [] };
const cmOf = (id: number, modname: string, instance: number, course = 9001) => ({
  cm: { id, course, modname, instance, name: 'x' },
});

const ids = (r: { discussions: Array<{ discussionId: number }> }) => r.discussions.map((d) => d.discussionId);

describe('helpers', () => {
  it('cleanFileUrl drops tokens and uses the webservice path', () => {
    expect(cleanFileUrl('https://h.example.com/pluginfile.php/1/a.pdf?token=abc')).toBe(
      'https://h.example.com/webservice/pluginfile.php/1/a.pdf',
    );
    expect(cleanFileUrl('https://h.example.com/webservice/pluginfile.php/1/a.pdf?forcedownload=1&token=abc')).toBe(
      'https://h.example.com/webservice/pluginfile.php/1/a.pdf?forcedownload=1',
    );
    expect(cleanFileUrl('https://h.example.com/webservice/pluginfile.php/1/a.pdf?token=abc&forcedownload=1')).toBe(
      'https://h.example.com/webservice/pluginfile.php/1/a.pdf?forcedownload=1',
    );
  });

  it('pickLang keeps one language per run of adjacent spans', () => {
    const html = '<span lang="ja" class="multilang">JA</span><span lang="en" class="multilang">EN</span>';
    expect(pickLang(html, 'ja')).toBe('JA');
    expect(pickLang(html, 'en_us')).toBe('EN');
    expect(pickLang(html, 'fr')).toBe('EN'); // English fallback
    expect(pickLang(html, null)).toBe(html);
    expect(pickLang('plain <b>text</b>', 'en')).toBe('plain <b>text</b>');
    expect(pickLang('<span lang="ja" class="multilang">only</span>', 'en')).toBe('only'); // no English: first
  });

  it('pickLang handles several runs, whitespace between spans and nested spans', () => {
    const html =
      '<p><span lang="ja" class="multilang">A-ja</span>\n<span lang="en" class="multilang">A-en</span></p>' +
      '<p>mid</p>' +
      '<span class="multilang" lang="ja">B-ja <span style="color:red">red</span></span>' +
      '<span class="multilang" lang="en">B-en <span style="color:red">red</span> end</span>';
    expect(pickLang(html, 'en')).toBe('<p>A-en</p><p>mid</p>B-en <span style="color:red">red</span> end');
    expect(pickLang(html, 'ja')).toBe('<p>A-ja</p><p>mid</p>B-ja <span style="color:red">red</span>');
  });

  it('clampInt', () => {
    expect(clampInt(undefined, 20, 1, 50)).toBe(20);
    expect(clampInt(500, 20, 1, 50)).toBe(50);
    expect(clampInt(0, 20, 1, 50)).toBe(1);
    expect(clampInt(7.9, 20, 1, 50)).toBe(7);
  });

  it('mapDiscussion decodes text and tolerates string reply counts', () => {
    const ref = mapForumRef(forumsC1[0]!, 'forum');
    const d = mapDiscussion(forumDiscussions.discussions![1]!, ref, 'C');
    expect(d).toMatchObject({
      forumType: 'forum',
      forumId: 3001,
      forumCmid: 7010,
      forumName: 'Announcements',
      forumKind: 'news',
      courseName: 'C',
      discussionId: 702,
      firstPostId: 802,
      subject: 'Room change & time',
      author: 'Hanako Suzuki',
      createdAt: '2026-10-05T12:00:00+09:00',
      modifiedAt: '2026-10-05T12:00:00+09:00',
      replies: 0,
      unread: 0,
      pinned: false,
      canCreateDiscussions: false,
      dueAt: null,
      cutoffAt: null,
    });
    const hsu = mapDiscussion(hsuDiscussions.discussions![0]!, mapForumRef(hsuForumsC1[0]!, 'hsuforum'), 'C');
    expect(hsu.replies).toBe(2);
  });
});

describe('listDiscussions', () => {
  const handlers = {
    mod_forum_get_forums_by_courses: forumsFor([...forumsC1, ...forumsC2]),
    mod_hsuforum_get_forums_by_courses: forumsFor(hsuForumsC1),
    mod_forum_get_forum_discussions: discussionsBy({ 3001: forumDiscussions, 3003: forumDiscussionsC2 }),
    mod_hsuforum_get_forum_discussions_paginated: discussionsBy({ 4001: hsuDiscussions }),
  };

  it('defaults to current-course forums (news and discussion), newest activity first', async () => {
    const { ctx, calls } = makeFakeContext(handlers);
    const r = await listDiscussions(ctx, {});
    expect(ids(r)).toEqual([751, 711, 701, 702]);
    expect(r.skippedForums).toBe(0);
    expect(r.discussions[0]).toMatchObject({
      courseName: 'Corporate Finance Basics',
      forumName: 'Advanced Forum',
      forumKind: 'general',
      canCreateDiscussions: true,
    });
    expect(r.discussions.find((d) => d.discussionId === 711)).toMatchObject({
      forumKind: 'news',
      canCreateDiscussions: false,
    });
    expect(r.forums.map((f) => f.forumId).sort((a, b) => a - b)).toEqual([3001, 3003, 4001]);
    expect(vi.mocked(listCourses)).toHaveBeenCalledWith(ctx);
    expect(calls[0]).toEqual({ fn: 'mod_forum_get_forums_by_courses', params: { courseids: [9001, 9002] } });
    expect(calls.filter((c) => c.fn === 'mod_forum_get_forum_discussions').map((c) => c.params.forumid)).toEqual([
      3003, 3001,
    ]);
    expect(countCalls(calls, 'mod_hsuforum_get_forum_discussions_paginated')).toBe(1);
  });

  it('only reads forums of scope courses', async () => {
    vi.mocked(listCourses).mockResolvedValueOnce([{ id: 9001, name: 'Corporate Finance Basics' } as Course]);
    const { ctx, calls } = makeFakeContext(handlers, { myCourseIds: [9001] });
    const r = await listDiscussions(ctx, {});
    expect(ids(r)).toEqual([751, 701, 702]);
    expect(calls[0]?.params).toEqual({ courseids: [9001] });
  });

  it('applies limit and sinceDays', async () => {
    const a = makeFakeContext(handlers);
    expect(ids(await listDiscussions(a.ctx, { limit: 1 }))).toEqual([751]);
    expect(a.calls.find((c) => c.fn === 'mod_forum_get_forum_discussions')?.params).toMatchObject({ perpage: 1 });
    const b = makeFakeContext(handlers);
    expect(ids(await listDiscussions(b.ctx, { sinceDays: 3 }))).toEqual([751, 711, 701]); // 2026-10-05 is older
  });

  it('courseId reads every forum type of the course', async () => {
    const { ctx, calls } = makeFakeContext(handlers);
    const r = await listDiscussions(ctx, { courseId: 9001 });
    expect(ids(r)).toEqual([751, 701, 702]);
    expect(r.discussions[0]).toMatchObject({
      forumType: 'hsuforum',
      forumName: 'Advanced Forum',
      author: 'Jiro Tanaka',
    });
    expect(calls.find((c) => c.fn === 'mod_hsuforum_get_forum_discussions_paginated')?.params).toEqual({
      forumid: 4001,
      sortby: 'timemodified',
      sortdirection: 'DESC',
      page: 0,
      perpage: 10, // several forums are read together: at most 10 each
    });
    expect(vi.mocked(listAllCourses)).toHaveBeenCalledWith(ctx);
  });

  it('treats a missing hsuforum module as "no forums"', async () => {
    const withoutHsu: Record<string, unknown> = { ...handlers };
    delete withoutHsu.mod_hsuforum_get_forums_by_courses; // the fake then throws a MoodleError
    const { ctx } = makeFakeContext(withoutHsu);
    expect(ids(await listDiscussions(ctx, { courseId: 9001 }))).toEqual([701, 702]);
  });

  it('forumCmid with courseId reads just that forum', async () => {
    const a = makeFakeContext(handlers);
    expect(ids(await listDiscussions(a.ctx, { forumCmid: 7010, courseId: 9001 }))).toEqual([701, 702]);
    expect(countCalls(a.calls, 'core_course_get_course_module')).toBe(0);
    await expect(
      listDiscussions(makeFakeContext(handlers).ctx, { forumCmid: 9999, courseId: 9001 }),
    ).rejects.toBeInstanceOf(NotFound);
    const empty = makeFakeContext(handlers);
    const emptyR = await listDiscussions(empty.ctx, { forumCmid: 7011, courseId: 9001 });
    expect(emptyR.discussions).toEqual([]);
    expect(emptyR.forums[0]).toMatchObject({
      forumId: 3002,
      forumKind: 'general',
      canCreateDiscussions: true,
    });
    expect(countCalls(empty.calls, 'mod_forum_get_forum_discussions')).toBe(0);
  });

  it('forumCmid alone resolves the course and type from the cmid', async () => {
    const { ctx, calls } = makeFakeContext({
      ...handlers,
      core_course_get_course_module: cmOf(7020, 'hsuforum', 4001),
    });
    expect(ids(await listDiscussions(ctx, { forumCmid: 7020 }))).toEqual([751]);
    expect(countCalls(calls, 'mod_forum_get_forums_by_courses')).toBe(0);
    expect(calls[0]).toEqual({ fn: 'core_course_get_course_module', params: { cmid: 7020 } });

    const notForum = makeFakeContext({ core_course_get_course_module: cmOf(7001, 'assign', 5001) });
    await expect(listDiscussions(notForum.ctx, { forumCmid: 7001 })).rejects.toBeInstanceOf(InvalidInput);
  });

  it('reads at most 15 forums per call and counts the rest and unreadable ones as skipped', async () => {
    const many: RawForum[] = Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i,
      course: 9001,
      cmid: 8000 + i,
      type: 'news',
      name: `F${i}`,
      numdiscussions: 1,
    }));
    const { ctx, calls } = makeFakeContext({
      mod_forum_get_forums_by_courses: forumsFor(many),
      mod_hsuforum_get_forums_by_courses: [],
      mod_forum_get_forum_discussions: (p: Record<string, unknown>) => {
        if (p.forumid === 103) throw new MoodleError('No permission', 'noviewdiscussionspermission');
        return {
          discussions: [
            {
              id: (p.forumid as number) * 10,
              discussion: p.forumid,
              subject: 'S',
              created: 1791860400,
              timemodified: 1791860400,
            },
          ],
        };
      },
    });
    const r = await listDiscussions(ctx, { courseId: 9001 });
    expect(countCalls(calls, 'mod_forum_get_forum_discussions')).toBe(15);
    expect(calls.find((c) => c.fn === 'mod_forum_get_forum_discussions')?.params).toMatchObject({
      perpage: 10,
      sortorder: 1,
    });
    expect(r.skippedForums).toBe(5 + 1);
    expect(r.discussions).toHaveLength(14);
  });

  it('pages a single forum and reports how many discussions remain', async () => {
    const page0 = {
      discussions: Array.from({ length: 20 }, (_, i) => ({
        id: 1000 + i,
        discussion: 2000 + i,
        subject: `T${i}`,
        created: 1791860400,
        timemodified: 1791860400 + i,
        numreplies: 0,
      })),
    };
    const forum = {
      id: 3001,
      course: 9001,
      cmid: 7010,
      type: 'general' as const,
      name: 'Q&A',
      cancreatediscussions: true,
      numdiscussions: 31,
    };
    const { ctx, calls } = makeFakeContext({
      mod_forum_get_forums_by_courses: [forum],
      mod_hsuforum_get_forums_by_courses: [],
      mod_forum_get_forum_discussions: page0,
    });
    const r = await listDiscussions(ctx, { forumCmid: 7010, courseId: 9001, limit: 20 });
    expect(r.discussions).toHaveLength(20);
    expect(r.truncatedForums).toEqual([
      { forumId: 3001, forumCmid: 7010, forumName: 'Q&A', remaining: 11, nextPage: 1, pageSize: 20 },
    ]);
    expect(calls.find((c) => c.fn === 'mod_forum_get_forum_discussions')?.params).toMatchObject({
      forumid: 3001,
      page: 0,
      perpage: 20,
      sortorder: 1,
    });

    const p1 = makeFakeContext({
      mod_forum_get_forums_by_courses: [forum],
      mod_hsuforum_get_forums_by_courses: [],
      mod_forum_get_forum_discussions: {
        discussions: page0.discussions.slice(0, 11),
      },
    });
    const next = await listDiscussions(p1.ctx, { forumCmid: 7010, courseId: 9001, limit: 20, page: 1 });
    expect(next.discussions).toHaveLength(11);
    expect(next.truncatedForums).toEqual([]);
    expect(p1.calls.find((c) => c.fn === 'mod_forum_get_forum_discussions')?.params).toMatchObject({ page: 1 });
  });

  it('rejects page without forum_cmid', async () => {
    await expect(listDiscussions(makeFakeContext(handlers).ctx, { page: 1 })).rejects.toBeInstanceOf(InvalidInput);
  });

  it('skips paginated hsuforum for anonymous forums and uses get_forum_discussions', async () => {
    const { ctx, calls } = makeFakeContext({
      mod_forum_get_forums_by_courses: [],
      mod_hsuforum_get_forums_by_courses: [hsuAnonForum],
      mod_hsuforum_get_forum_discussions_paginated: {
        discussions: [],
        warnings: [{ message: 'Anonymous forums not supported yet' }],
      },
      mod_hsuforum_get_forum_discussions: hsuAnonDiscussions,
    });
    const r = await listDiscussions(ctx, { forumCmid: 7021, courseId: 9001 });
    expect(ids(r)).toEqual([5369]);
    expect(countCalls(calls, 'mod_hsuforum_get_forum_discussions_paginated')).toBe(0);
    expect(countCalls(calls, 'mod_hsuforum_get_forum_discussions')).toBe(1);
    expect(calls.find((c) => c.fn === 'mod_hsuforum_get_forum_discussions')?.params).toMatchObject({
      forumid: 4002,
      sortorder: 1,
      page: 0,
      perpage: 20,
    });
  });

  it('falls back to get_forum_discussions when paginated hsuforum returns empty with a warning', async () => {
    const { ctx, calls } = makeFakeContext({
      mod_forum_get_forums_by_courses: [],
      mod_hsuforum_get_forums_by_courses: [{ ...hsuAnonForum, anonymous: 0 }],
      mod_hsuforum_get_forum_discussions_paginated: {
        discussions: [],
        warnings: [{ message: 'Anonymous forums not supported yet' }],
      },
      mod_hsuforum_get_forum_discussions: hsuAnonDiscussions,
    });
    const r = await listDiscussions(ctx, { forumCmid: 7021, courseId: 9001 });
    expect(ids(r)).toEqual([5369]);
    expect(countCalls(calls, 'mod_hsuforum_get_forum_discussions_paginated')).toBe(1);
    expect(countCalls(calls, 'mod_hsuforum_get_forum_discussions')).toBe(1);
    expect(calls.find((c) => c.fn === 'mod_hsuforum_get_forum_discussions')?.params).toMatchObject({
      page: 0,
      perpage: 20,
    });
  });

  it('does not fall back on an ordinary empty page of a non-anonymous hsuforum', async () => {
    const { ctx, calls } = makeFakeContext({
      mod_forum_get_forums_by_courses: [],
      mod_hsuforum_get_forums_by_courses: [{ ...hsuAnonForum, anonymous: 0, numdiscussions: 8 }],
      mod_hsuforum_get_forum_discussions_paginated: { discussions: [] },
      mod_hsuforum_get_forum_discussions: hsuAnonDiscussions,
    });
    const r = await listDiscussions(ctx, { forumCmid: 7021, courseId: 9001, page: 3 });
    expect(r.discussions).toEqual([]);
    expect(r.truncatedForums).toEqual([]);
    expect(countCalls(calls, 'mod_hsuforum_get_forum_discussions_paginated')).toBe(1);
    expect(countCalls(calls, 'mod_hsuforum_get_forum_discussions')).toBe(0);
  });

  it('pages anonymous hsuforum on the server when the history is large', async () => {
    const all = Array.from({ length: 40 }, (_, i) => ({
      id: 2000 + i,
      discussion: 1000 + i,
      subject: `S${i}`,
      message: `<p>${'x'.repeat(400)}</p>`,
      created: 1791860400 + i,
      timemodified: 1791860400 + i,
      numreplies: 0,
    }));
    const { ctx, calls } = makeFakeContext({
      mod_forum_get_forums_by_courses: [],
      mod_hsuforum_get_forums_by_courses: [{ ...hsuAnonForum, numdiscussions: 40 }],
      mod_hsuforum_get_forum_discussions_paginated: { discussions: all },
      mod_hsuforum_get_forum_discussions: (p: Record<string, unknown>) => {
        const perpage = typeof p.perpage === 'number' && p.perpage > 0 ? p.perpage : all.length;
        const page = typeof p.page === 'number' && p.page >= 0 ? p.page : 0;
        return { discussions: all.slice(page * perpage, page * perpage + perpage) };
      },
    });
    const r = await listDiscussions(ctx, { forumCmid: 7021, courseId: 9001, limit: 1 });
    expect(ids(r)).toEqual([1000]);
    expect(countCalls(calls, 'mod_hsuforum_get_forum_discussions_paginated')).toBe(0);
    expect(calls.find((c) => c.fn === 'mod_hsuforum_get_forum_discussions')?.params).toEqual({
      forumid: 4002,
      sortorder: 1,
      page: 0,
      perpage: 1,
    });
  });

  it('keeps the multi-forum page size in continuation and has no gaps when that hint is followed', async () => {
    const raw = (forumId: number, i: number, timemodified: number) => ({
      id: forumId * 1000 + i,
      discussion: forumId * 100 + i,
      subject: `T${forumId}-${i}`,
      userfullname: 'Ann',
      created: timemodified,
      timemodified,
      numreplies: 0,
    });
    const aAll = Array.from({ length: 15 }, (_, i) => raw(501, i, 1000 + i));
    const bAll = Array.from({ length: 15 }, (_, i) => raw(502, i, 200 + i));
    const cAll = [50, 51, 52, 53, 250].map((t, i) => raw(503, i, t));
    const byForum: Record<number, typeof aAll> = { 501: aAll, 502: bAll, 503: cAll };
    const forum = (id: number, cmid: number, name: string, n: number, modified: number): RawForum => ({
      id,
      course: 9001,
      cmid,
      type: 'general',
      name,
      cancreatediscussions: true,
      numdiscussions: n,
      timemodified: modified,
    });
    const paged = (p: Record<string, unknown>) => {
      const all = byForum[p.forumid as number] ?? [];
      const sorted = [...all].sort((a, b) => (b.timemodified ?? 0) - (a.timemodified ?? 0));
      const perpage = typeof p.perpage === 'number' && p.perpage > 0 ? p.perpage : sorted.length;
      const page = typeof p.page === 'number' && p.page >= 0 ? p.page : 0;
      return { discussions: sorted.slice(page * perpage, page * perpage + perpage) };
    };
    const handlers = {
      mod_forum_get_forums_by_courses: forumsFor([
        forum(501, 8501, 'A', 15, 1014),
        forum(502, 8502, 'B', 15, 214),
        forum(503, 8503, 'C', 5, 250),
      ]),
      mod_hsuforum_get_forums_by_courses: [],
      mod_forum_get_forum_discussions: paged,
    };
    const first = makeFakeContext(handlers);
    const r = await listDiscussions(first.ctx, {});
    expect(r.discussions).toHaveLength(20);
    expect(r.discussions.filter((d) => d.forumId === 501)).toHaveLength(10);
    expect(r.discussions.filter((d) => d.forumId === 502)).toHaveLength(9);
    expect(r.discussions.filter((d) => d.forumId === 503)).toHaveLength(1);
    expect(r.truncatedForums).toEqual([
      { forumId: 501, forumCmid: 8501, forumName: 'A', remaining: 5, nextPage: 1, pageSize: 10 },
      { forumId: 503, forumCmid: 8503, forumName: 'C', remaining: 4, nextPage: 0, pageSize: 10 },
      { forumId: 502, forumCmid: 8502, forumName: 'B', remaining: 6, nextPage: 0, pageSize: 10 },
    ]);
    expect(first.calls.filter((c) => c.fn === 'mod_forum_get_forum_discussions').map((c) => c.params.perpage)).toEqual([
      10, 10, 10,
    ]);

    const aHint = r.truncatedForums.find((t) => t.forumId === 501)!;
    const aNext = makeFakeContext(handlers);
    const aPage = await listDiscussions(aNext.ctx, {
      forumCmid: 8501,
      courseId: 9001,
      page: aHint.nextPage,
      limit: aHint.pageSize,
    });
    const aIds = [
      ...r.discussions.filter((d) => d.forumId === 501).map((d) => d.discussionId),
      ...aPage.discussions.map((d) => d.discussionId),
    ].sort((a, b) => a - b);
    expect(aIds).toEqual(Array.from({ length: 15 }, (_, i) => 50100 + i));
    expect(new Set(aIds).size).toBe(15);

    const bHint = r.truncatedForums.find((t) => t.forumId === 502)!;
    const bNext = makeFakeContext(handlers);
    const bPage = await listDiscussions(bNext.ctx, {
      forumCmid: 8502,
      courseId: 9001,
      page: bHint.nextPage,
      limit: bHint.pageSize,
    });
    expect(r.discussions.some((d) => d.discussionId === 50205)).toBe(false);
    expect(bPage.discussions.map((d) => d.discussionId)).toContain(50205);
    expect(bPage.discussions).toHaveLength(10);
  });
});

describe('getDiscussion', () => {
  it('forum: posts oldest first, summary resolved through the course forums', async () => {
    const { ctx, calls } = makeFakeContext({
      mod_forum_get_discussion_posts: forumPosts,
      mod_forum_get_forums_by_courses: forumsC1,
    });
    const d = await getDiscussion(ctx, { forumType: 'forum', discussionId: 701 });
    expect(calls[0]).toEqual({
      fn: 'mod_forum_get_discussion_posts',
      params: { discussionid: 701, sortby: 'created', sortdirection: 'ASC' },
    });
    expect(d.canReply).toBe(true);
    expect(d.summary).toMatchObject({
      forumType: 'forum',
      forumId: 3001,
      forumCmid: 7010,
      forumName: 'Announcements',
      forumKind: 'news',
      courseId: 9001,
      courseName: 'Corporate Finance Basics',
      discussionId: 701,
      firstPostId: 801,
      subject: 'Midterm info',
      author: 'Hanako Suzuki',
      createdAt: '2026-10-13T12:00:00+09:00',
      modifiedAt: '2026-10-14T10:00:00+09:00',
      replies: 1,
      unread: 1,
      canCreateDiscussions: false,
    });
    expect(d.forumIntro).toContain('News & updates');
    expect(d.posts.map((p) => [p.id, p.parentId, p.unread, p.canReply])).toEqual([
      [801, null, false, true],
      [803, 801, true, true],
    ]);
    expect(d.posts[0]?.message).toContain('Bring your');
    expect(d.posts[0]?.attachments).toEqual([
      {
        name: 'rules.pdf',
        size: 100,
        mime: 'application/pdf',
        url: `${FAKE_BASE_URL}/webservice/pluginfile.php/222/mod_forum/attachment/801/rules.pdf`,
        modified: '2026-10-13T12:00:00+09:00',
      },
    ]);
    expect(d.posts[1]?.message).toContain('Thanks & see you.');
  });

  it('hsuforum: sorted oldest first, hidden authors stay empty, forum unknown without a hint', async () => {
    const { ctx, calls } = makeFakeContext({ mod_hsuforum_get_forum_discussion_posts: hsuPosts });
    const d = await getDiscussion(ctx, { forumType: 'hsuforum', discussionId: 751 });
    expect(calls).toEqual([{ fn: 'mod_hsuforum_get_forum_discussion_posts', params: { discussionid: 751 } }]);
    expect(d.posts.map((p) => [p.id, p.parentId, p.author])).toEqual([
      [951, null, 'Jiro Tanaka'],
      [952, 951, ''],
    ]);
    expect(d.posts[0]?.attachments[0]?.url).toBe(
      `${FAKE_BASE_URL}/webservice/pluginfile.php/666/mod_hsuforum/attachment/951/notes.txt`,
    );
    expect(d.canReply).toBe(true);
    expect(d.summary).toMatchObject({
      forumType: 'hsuforum',
      forumId: 0,
      forumCmid: null,
      forumName: '',
      forumKind: 'general',
      courseId: 0,
      discussionId: 751,
      firstPostId: 951,
      subject: 'Group topic',
      replies: 1,
      unread: 1,
      canCreateDiscussions: false,
    });
    expect(d.forumIntro).toBe('');
    expect(d.posts.map((p) => [p.id, p.unread, p.canReply])).toEqual([
      [951, false, true],
      [952, true, true],
    ]);
  });

  it('hsuforum: forumCmid resolves forum and course', async () => {
    const { ctx } = makeFakeContext({
      mod_hsuforum_get_forum_discussion_posts: hsuPosts,
      core_course_get_course_module: cmOf(7020, 'hsuforum', 4001),
      mod_hsuforum_get_forums_by_courses: hsuForumsC1,
    });
    const d = await getDiscussion(ctx, { forumType: 'hsuforum', discussionId: 751, forumCmid: 7020 });
    expect(d.summary).toMatchObject({
      forumId: 4001,
      forumCmid: 7020,
      forumName: 'Advanced Forum',
      forumKind: 'general',
      courseId: 9001,
      courseName: 'Corporate Finance Basics',
      canCreateDiscussions: true,
      dueAt: '2026-10-20T23:59:00+09:00',
    });
    expect(d.forumIntro).toContain('Group talk');
  });

  it('canReply follows each post, not only the first', async () => {
    const { ctx } = makeFakeContext({
      mod_forum_get_discussion_posts: { posts: [{ id: 1, message: '<p>a</p>', timecreated: 1791860400 }] },
    });
    expect((await getDiscussion(ctx, { forumType: 'forum', discussionId: 1 })).canReply).toBe(false);

    const mixed = makeFakeContext({
      mod_forum_get_discussion_posts: {
        posts: [
          { id: 1, message: '<p>root</p>', timecreated: 1, hasparent: false, capabilities: { reply: false } },
          {
            id: 2,
            message: '<p>later</p>',
            timecreated: 2,
            hasparent: true,
            parentid: 1,
            capabilities: { reply: true },
          },
        ],
      },
    });
    const d = await getDiscussion(mixed.ctx, { forumType: 'forum', discussionId: 1 });
    expect(d.canReply).toBe(true);
    expect(d.posts.map((p) => p.canReply)).toEqual([false, true]);
  });

  it('post_id returns that post and its parent', async () => {
    const { ctx } = makeFakeContext({
      mod_forum_get_discussion_posts: forumPosts,
      mod_forum_get_forums_by_courses: forumsC1,
    });
    const d = await getDiscussion(ctx, { forumType: 'forum', discussionId: 701, postId: 803 });
    expect(d.posts.map((p) => p.id)).toEqual([801, 803]);
    expect(d.canReply).toBe(true);
    await expect(getDiscussion(ctx, { forumType: 'forum', discussionId: 701, postId: 999 })).rejects.toBeInstanceOf(
      NotFound,
    );
  });

  it('throws NotFound when Moodle rejects the id or nothing is readable', async () => {
    const bad = makeFakeContext({
      mod_forum_get_discussion_posts: () => {
        throw new MoodleError('Invalid discussion', 'invalidrecord');
      },
    });
    await expect(getDiscussion(bad.ctx, { forumType: 'forum', discussionId: 1 })).rejects.toBeInstanceOf(NotFound);
    const none = makeFakeContext({ mod_forum_get_discussion_posts: { posts: [], forumid: 1, courseid: 1 } });
    await expect(getDiscussion(none.ctx, { forumType: 'forum', discussionId: 1 })).rejects.toBeInstanceOf(NotFound);
  });

  it('tells the caller to use discussion_id when a first-post id is passed', async () => {
    const { ctx } = makeFakeContext({
      mod_forum_get_discussion_posts: () => {
        throw new MoodleError('Call to a member function get_forum_id() on null', 'moodle_error');
      },
      mod_forum_get_discussion_post: { post: { id: 801, discussionid: 701 } },
    });
    await expect(getDiscussion(ctx, { forumType: 'forum', discussionId: 801 })).rejects.toMatchObject({
      name: 'InvalidInput',
      message: '801 is a post id. Use discussion_id 701 from list_discussions.',
    });
  });
});
