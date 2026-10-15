import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, NeedsReconnect } from '../../src/core/errors';
import { listAllCourses, listCourses } from '../../src/core/services/courses';
import { searchForums } from '../../src/core/services/forums-search';
import {
  searchForums as forumList,
  messageSearchResponse,
  searchDiscussionsByForum,
  searchHsuDiscussions,
  searchHsuForums,
} from '../fixtures/forum-search';
import { countCalls, type FakeCall, makeFakeContext } from '../helpers/fake-context-be3';

vi.mock('../../src/core/services/courses', () => {
  const courses = [{ id: 9001, name: 'Corporate Finance Basics' }];
  return { listCourses: vi.fn(async () => courses), listAllCourses: vi.fn(async () => courses) };
});

beforeEach(() => {
  vi.mocked(listCourses).mockClear();
  vi.mocked(listAllCourses).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

const byCourse = (p: Record<string, unknown>) => forumList.filter((f) => (p.courseids as number[]).includes(f.course));
const discussionsOf = (p: Record<string, unknown>) =>
  searchDiscussionsByForum[p.forumid as number] ?? { discussions: [] };

function setup(extra: Record<string, unknown> = {}) {
  return makeFakeContext({
    mod_forum_get_forums_by_courses: byCourse,
    mod_forum_get_forum_discussions: discussionsOf,
    ...extra,
  });
}

const ids = (r: { hits: Array<{ discussionId: number }> }) => r.hits.map((h) => h.discussionId);

describe('searchForums: discussions', () => {
  it('needs every word, ignores case and ranks subject matches first', async () => {
    const { ctx } = setup();
    const r = await searchForums(ctx, { query: '  MIDTERM   exam ' });
    expect(r.query).toBe('MIDTERM   exam');
    expect(ids(r)).toEqual([701, 702]); // 811 mentions the midterm but not the exam
    expect(r.hits[0]).toMatchObject({ inSubject: true, subject: 'Midterm exam room', forumCmid: 7010 });
    expect(r.hits[0]?.snippet).toContain('Room 301');
    expect(r.hits[1]).toMatchObject({ inSubject: false, courseName: 'Corporate Finance Basics' });
    expect(r.hits[1]?.snippet).toContain('midterm exam schedule');
    expect(r.messages).toBeNull();
    expect(r.messagesNote).toBeNull();
  });

  it('folds full-width forms (NFKC) in the subject and the query', async () => {
    const { ctx } = setup();
    const r = await searchForums(ctx, { query: 'report due' });
    expect(ids(r)).toEqual([703, 711]); // 703: both words in the full-width subject; 711: one in the body
    expect(r.hits[0]?.inSubject).toBe(true);
    expect(r.hits[1]?.inSubject).toBe(false);
    expect(ids(await searchForums(ctx, { query: 'ｍｉｄｔｅｒｍ' }))).toEqual([701, 711, 702]);
  });

  it('searches only the given course and reads announcements first', async () => {
    const { ctx, calls } = setup();
    await searchForums(ctx, { query: 'midterm', courseId: 9001 });
    expect(vi.mocked(listCourses)).not.toHaveBeenCalled();
    expect(calls.find((c) => c.fn === 'mod_forum_get_forums_by_courses')?.params).toEqual({ courseids: [9001] });
    const order = calls.filter((c) => c.fn === 'mod_forum_get_forum_discussions').map((c) => c.params.forumid);
    expect(order).toEqual([3001, 3002]);
  });

  it('defaults to the courses in scope and costs one call per forum', async () => {
    const { ctx, calls } = setup();
    await searchForums(ctx, { query: 'midterm' });
    expect(vi.mocked(listCourses)).toHaveBeenCalledWith(ctx);
    expect(calls.find((c) => c.fn === 'mod_forum_get_forums_by_courses')?.params).toEqual({ courseids: [9001] });
    expect(countCalls(calls, 'mod_forum_get_forum_discussions')).toBe(2);
  });

  it('includes Open LMS forums and sorts the rest by recent activity', async () => {
    const { ctx } = setup({
      mod_hsuforum_get_forums_by_courses: searchHsuForums,
      mod_hsuforum_get_forum_discussions_paginated: searchHsuDiscussions,
    });
    const r = await searchForums(ctx, { query: 'midterm exam' });
    expect(ids(r)).toEqual([701, 751, 702]);
    expect(r.hits[1]?.forumType).toBe('hsuforum');
  });

  it('caps the number of results and counts forums that could not be read', async () => {
    const { ctx } = setup({
      mod_forum_get_forum_discussions: (p: Record<string, unknown>) => {
        if (p.forumid === 3002) throw new MoodleError('no access', 'nopermissions');
        return discussionsOf(p);
      },
    });
    const r = await searchForums(ctx, { query: 'midterm', limit: 1 });
    expect(r.hits).toHaveLength(1);
    expect(r.skippedForums).toBe(1);
    expect(r.perForum).toBe(20);
  });

  it('rejects a query without words', async () => {
    const { ctx, calls } = setup();
    await expect(searchForums(ctx, { query: '  　 ' })).rejects.toBeInstanceOf(InvalidInput);
    expect(calls).toHaveLength(0);
  });

  it('returns nothing when no discussion matches', async () => {
    const { ctx } = setup();
    expect((await searchForums(ctx, { query: 'zebra' })).hits).toEqual([]);
  });
});

describe('searchForums: snippets and CPU bounds', () => {
  const longPost = (message: string) => ({
    discussions: [
      {
        id: 1,
        discussion: 1,
        subject: 'Long post',
        message,
        userfullname: 'Hanako Suzuki',
        created: 1791860400,
        timemodified: 1791860400,
        numreplies: 0,
        numunread: 0,
        pinned: false,
      },
    ],
  });
  const forumsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: 5000 + i,
      course: 9001,
      cmid: 8000 + i,
      type: 'general',
      name: `Forum ${i}`,
      intro: '',
      numdiscussions: 1,
    }));

  it('cuts the snippet at the right place even when lower-casing changes the text length', async () => {
    // "İ" lower-cases to two characters: positions found in the lower-cased text would be wrong in the original
    const message = `<p>${'İ'.repeat(80)} target word follows here.</p>`;
    const { ctx } = makeFakeContext({
      mod_forum_get_forums_by_courses: forumsOf(1),
      mod_forum_get_forum_discussions: longPost(message),
    });
    const r = await searchForums(ctx, { query: 'TARGET' });
    expect(r.hits[0]?.snippet.startsWith('…İ')).toBe(true);
    expect(r.hits[0]?.snippet).toContain('target word follows here.');
  });

  it('reads less of every first post when more than 5 forums are scanned', async () => {
    const message = `<p>${'x '.repeat(1500)}needle</p>`; // the word sits ~3000 characters in
    const run = async (forums: number) => {
      const { ctx } = makeFakeContext({
        mod_forum_get_forums_by_courses: forumsOf(forums),
        mod_forum_get_forum_discussions: longPost(message),
      });
      return (await searchForums(ctx, { query: 'needle' })).hits.length;
    };
    expect(await run(5)).toBe(5); // every forum returns the same discussion
    expect(await run(6)).toBe(0);
  });
});

describe('searchForums: messages', () => {
  const searchCall = (calls: FakeCall[]) =>
    calls.find((c) => c.fn === 'core_message_data_for_messagearea_search_messages');

  it('adds message hits with one extra call', async () => {
    const { ctx, calls } = setup({ core_message_data_for_messagearea_search_messages: messageSearchResponse });
    const r = await searchForums(ctx, { query: ' midterm ', includeMessages: true });
    expect(searchCall(calls)?.params).toEqual({ userid: 1001, search: 'midterm', limitfrom: 0, limitnum: 10 });
    expect(r.messagesNote).toBeNull();
    expect(r.messages).toEqual([
      {
        conversationId: 55,
        userId: 2002,
        name: 'Ken Sato',
        text: 'Can we meet before the midterm?',
        sentAt: '2026-10-14T11:00:00+09:00',
        fromMe: false,
      },
      {
        conversationId: null,
        userId: 2003,
        name: 'Hanako Suzuki',
        text: 'See you at the midterm',
        sentAt: '2026-10-13T09:06:40+09:00',
        fromMe: true,
      },
    ]);
  });

  it('does not search messages unless asked', async () => {
    const { ctx, calls } = setup({ core_message_data_for_messagearea_search_messages: messageSearchResponse });
    await searchForums(ctx, { query: 'midterm' });
    expect(searchCall(calls)).toBeUndefined();
  });

  it('keeps the discussion results when the message search fails', async () => {
    const { ctx } = setup({
      core_message_data_for_messagearea_search_messages: () => {
        throw new MoodleError('disabled', 'servicenotavailable');
      },
    });
    const r = await searchForums(ctx, { query: 'midterm', includeMessages: true });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.messages).toEqual([]);
    expect(r.messagesNote).toContain('skipped');
  });

  it('gives up on a message search that hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { ctx } = setup({ core_message_data_for_messagearea_search_messages: () => new Promise(() => undefined) });
    const pending = searchForums(ctx, { query: 'midterm', includeMessages: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    const r = await pending;
    expect(r.messages).toEqual([]);
    expect(r.messagesNote).toContain('skipped');
    expect(ids(r)).toContain(701);
  });

  it('still asks for a reconnect when the connection expired', async () => {
    const { ctx } = setup({
      core_message_data_for_messagearea_search_messages: () => {
        throw new NeedsReconnect();
      },
    });
    await expect(searchForums(ctx, { query: 'midterm', includeMessages: true })).rejects.toBeInstanceOf(NeedsReconnect);
  });
});
