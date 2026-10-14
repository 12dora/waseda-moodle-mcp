import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, NotFound } from '../../src/core/errors';
import { listAllCourses, listCourses } from '../../src/core/services/courses';
import {
  getDiscussion,
  listDiscussions,
  mapDiscussion,
  mapForumRef,
  type RawDiscussionList,
  type RawForum,
} from '../../src/core/services/forums';
import { clampInt, cleanFileUrl, pickLang } from '../../src/core/services/shared';
import type { Course } from '../../src/core/types';
import {
  forumDiscussions,
  forumDiscussionsC2,
  forumPosts,
  forumsC1,
  forumsC2,
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

  it('defaults to announcement forums of the courses in scope, newest activity first', async () => {
    const { ctx, calls } = makeFakeContext(handlers);
    const r = await listDiscussions(ctx, {});
    expect(ids(r)).toEqual([711, 701, 702]);
    expect(r.skippedForums).toBe(0);
    expect(r.discussions[0]).toMatchObject({ courseName: 'Seminar & Lab', forumName: 'Announcements' });
    expect(vi.mocked(listCourses)).toHaveBeenCalledWith(ctx);
    expect(calls[0]).toEqual({ fn: 'mod_forum_get_forums_by_courses', params: { courseids: [9001, 9002] } });
    // general / empty forums are never read
    expect(calls.filter((c) => c.fn === 'mod_forum_get_forum_discussions').map((c) => c.params.forumid)).toEqual([
      3001, 3003,
    ]);
    expect(countCalls(calls, 'mod_hsuforum_get_forum_discussions_paginated')).toBe(0);
  });

  it('only reads announcements of scope courses', async () => {
    vi.mocked(listCourses).mockResolvedValueOnce([{ id: 9001, name: 'Corporate Finance Basics' } as Course]);
    const { ctx, calls } = makeFakeContext(handlers, { myCourseIds: [9001] });
    const r = await listDiscussions(ctx, {});
    expect(ids(r)).toEqual([701, 702]);
    expect(calls[0]?.params).toEqual({ courseids: [9001] });
  });

  it('applies limit and sinceDays', async () => {
    const a = makeFakeContext(handlers);
    expect(ids(await listDiscussions(a.ctx, { limit: 1 }))).toEqual([711]);
    expect(a.calls.find((c) => c.fn === 'mod_forum_get_forum_discussions')?.params).toMatchObject({ perpage: 1 });
    const b = makeFakeContext(handlers);
    expect(ids(await listDiscussions(b.ctx, { sinceDays: 3 }))).toEqual([711, 701]); // 2026-10-05 is older
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
    expect((await listDiscussions(empty.ctx, { forumCmid: 7011, courseId: 9001 })).discussions).toEqual([]);
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
    expect(calls.find((c) => c.fn === 'mod_forum_get_forum_discussions')?.params).toMatchObject({ perpage: 10 });
    expect(r.skippedForums).toBe(5 + 1);
    expect(r.discussions).toHaveLength(14);
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
    });
    expect(d.posts.map((p) => [p.id, p.parentId])).toEqual([
      [801, null],
      [803, 801],
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
      courseId: 0,
      discussionId: 751,
      firstPostId: 951,
      subject: 'Group topic',
      replies: 1,
      unread: 1,
    });
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
      courseId: 9001,
      courseName: 'Corporate Finance Basics',
    });
  });

  it('canReply is false when the post carries no reply capability', async () => {
    const { ctx } = makeFakeContext({
      mod_forum_get_discussion_posts: { posts: [{ id: 1, message: '<p>a</p>', timecreated: 1791860400 }] },
    });
    expect((await getDiscussion(ctx, { forumType: 'forum', discussionId: 1 })).canReply).toBe(false);
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
});
