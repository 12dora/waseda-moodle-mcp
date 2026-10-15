import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, NeedsReconnect } from '../../src/core/errors';
import { renderPeople } from '../../src/core/mcp/render/messages';
import { listAllCourses, listCourses } from '../../src/core/services/courses';
import type { RawDiscussion, RawForum } from '../../src/core/services/forums';
import { searchPeople } from '../../src/core/services/messages/people';
import { countCalls, makeFakeContext } from '../helpers/fake-context-be3';

vi.mock('../../src/core/services/courses', () => {
  const courses = [
    { id: 9001, name: 'Corporate Finance Basics' },
    { id: 9002, name: 'Academic Writing' },
  ];
  return { listCourses: vi.fn(async () => courses), listAllCourses: vi.fn(async () => courses) };
});

beforeEach(() => {
  vi.mocked(listCourses).mockClear();
  vi.mocked(listAllCourses).mockClear();
});

// synthetic people: 1001 is the user; 2001 teaches (announcements), 2002 is a classmate seen in forums and chats
const ICHIRO = 'SUZUKI, Ichiro 鈴木 一郎';
const HANAKO = 'SUZUKI, Hanako 鈴木 花子';

const forums: RawForum[] = [
  { id: 3002, course: 9001, cmid: 7011, type: 'general', name: 'Q&amp;A', intro: '', numdiscussions: 3 },
  { id: 3001, course: 9001, cmid: 7010, type: 'news', name: 'Announcements', intro: '', numdiscussions: 2 },
  { id: 3003, course: 9002, cmid: 7012, type: 'general', name: 'Chat', intro: '', numdiscussions: 1 },
  { id: 3004, course: 9002, cmid: 7013, type: 'general', name: 'Empty', intro: '', numdiscussions: 0 },
];

const post = (id: number, userid: number | null, userfullname: string): RawDiscussion => ({
  id,
  discussion: id + 100,
  subject: `Topic ${id}`,
  userid,
  userfullname,
  timemodified: 1791939600,
});

const discussionsByForum: Record<number, { discussions: RawDiscussion[] }> = {
  3001: { discussions: [post(1, 2001, ICHIRO), post(2, 2001, ICHIRO)] },
  3002: { discussions: [post(3, 2002, HANAKO), post(4, 2002, HANAKO), post(5, 1001, 'Taro Yamada')] },
  3003: { discussions: [post(6, 2002, HANAKO)] },
};

const conversations = {
  conversations: [
    {
      id: 55,
      type: 1,
      members: [
        { id: 1001, fullname: 'Taro Yamada' },
        { id: 2002, fullname: 'SUZUKI, Hanako 鈴木 花子' },
      ],
    },
    {
      id: 56,
      type: 2,
      members: [
        { id: 1001, fullname: 'Taro Yamada' },
        { id: 2003, fullname: 'Kenji &amp; Co SATO' },
        { id: 2004, fullname: '' },
      ],
    },
    {
      id: 57,
      type: 3,
      members: [
        { id: 1001, fullname: 'Taro Yamada' },
        { id: 2099, fullname: 'Suzuki Myself' },
      ],
    },
  ],
};

function setup(extra: Record<string, unknown> = {}) {
  return makeFakeContext({
    mod_forum_get_forums_by_courses: (p: Record<string, unknown>) =>
      forums.filter((f) => (p.courseids as number[]).includes(f.course)),
    mod_forum_get_forum_discussions: (p: Record<string, unknown>) =>
      discussionsByForum[p.forumid as number] ?? { discussions: [] },
    core_message_get_conversations: conversations,
    ...extra,
  });
}

const ids = (r: { people: Array<{ id: number }> }) => r.people.map((p) => p.id);

describe('searchPeople', () => {
  it('lists announcement authors first, then the most often seen, deduped and without yourself', async () => {
    const { ctx } = setup();
    const r = await searchPeople(ctx, { query: '鈴木' });
    expect(r.query).toBe('鈴木');
    expect(r.people).toEqual([
      {
        id: 2001,
        name: ICHIRO,
        courses: ['Corporate Finance Basics'],
        inConversation: false,
        announcements: true,
        seen: 2,
      },
      {
        id: 2002,
        name: HANAKO,
        courses: ['Corporate Finance Basics', 'Academic Writing'],
        inConversation: true,
        announcements: false,
        seen: 4,
      },
    ]);
    expect(r.skippedForums).toBe(0);
  });

  it('needs every word, ignores case and folds full-width forms in romaji and Japanese names', async () => {
    const { ctx } = setup();
    expect(ids(await searchPeople(ctx, { query: 'hanako SUZUKI' }))).toEqual([2002]);
    expect(ids(await searchPeople(ctx, { query: 'ｓｕｚｕｋｉ' }))).toEqual([2001, 2002]);
    expect(ids(await searchPeople(ctx, { query: '尾崎' }))).toEqual([]);
    expect(ids(await searchPeople(ctx, { query: 'suzuki 一郎' }))).toEqual([2001]);
    expect(ids(await searchPeople(ctx, { query: 'suzuki zebra' }))).toEqual([]);
  });

  it('finds people only seen in a conversation; yourself and your personal space do not count', async () => {
    const { ctx } = setup();
    const r = await searchPeople(ctx, { query: 'kenji' });
    expect(r.people).toEqual([
      { id: 2003, name: 'Kenji & Co SATO', courses: [], inConversation: true, announcements: false, seen: 1 },
    ]);
    expect(ids(await searchPeople(ctx, { query: 'yamada' }))).toEqual([]);
    expect(ids(await searchPeople(ctx, { query: 'myself' }))).toEqual([]);
  });

  it('costs one call per forum plus one for conversations, and never calls the site-wide user search', async () => {
    const { ctx, calls } = setup();
    await searchPeople(ctx, { query: 'suzuki' });
    expect(vi.mocked(listCourses)).toHaveBeenCalledWith(ctx);
    expect(countCalls(calls, 'mod_forum_get_forum_discussions')).toBe(3); // the empty forum is not read
    expect(countCalls(calls, 'core_message_get_conversations')).toBe(1);
    expect(calls.find((c) => c.fn === 'core_message_get_conversations')?.params).toEqual({
      userid: 1001,
      limitfrom: 0,
      limitnum: 50,
    });
    expect(countCalls(calls, 'core_message_message_search_users')).toBe(0);
  });

  it('narrows to one course and then leaves conversations out', async () => {
    const { ctx, calls } = setup();
    const r = await searchPeople(ctx, { query: 'suzuki', courseId: 9002 });
    expect(vi.mocked(listCourses)).not.toHaveBeenCalled();
    expect(calls.find((c) => c.fn === 'mod_forum_get_forums_by_courses')?.params).toEqual({ courseids: [9002] });
    expect(countCalls(calls, 'core_message_get_conversations')).toBe(0);
    expect(r.people).toMatchObject([{ id: 2002, courses: ['Academic Writing'], inConversation: false, seen: 1 }]);
  });

  it('reads Open LMS forums too and ignores authors without a user id', async () => {
    const { ctx } = setup({
      mod_hsuforum_get_forums_by_courses: [
        { id: 4001, course: 9001, cmid: 7020, type: 'general', name: 'Advanced', intro: '', numdiscussions: 2 },
      ],
      mod_hsuforum_get_forum_discussions_paginated: {
        discussions: [post(9, 2005, 'Jiro TANAKA'), post(10, null, 'Jiro TANAKA')],
      },
    });
    const r = await searchPeople(ctx, { query: 'jiro' });
    expect(r.people).toMatchObject([{ id: 2005, name: 'Jiro TANAKA', seen: 1 }]);
  });

  it('honours the limit', async () => {
    const { ctx } = setup();
    expect(ids(await searchPeople(ctx, { query: 'suzuki', limit: 1 }))).toEqual([2001]);
  });

  it('counts forums it could not read and keeps going when conversations fail', async () => {
    const { ctx } = setup({
      mod_forum_get_forum_discussions: (p: Record<string, unknown>) => {
        if (p.forumid === 3003) throw new MoodleError('no access', 'nopermissions');
        return discussionsByForum[p.forumid as number] ?? { discussions: [] };
      },
      core_message_get_conversations: () => {
        throw new MoodleError('disabled', 'servicenotavailable');
      },
    });
    const r = await searchPeople(ctx, { query: 'suzuki' });
    expect(r.skippedForums).toBe(1);
    expect(r.people).toMatchObject([
      { id: 2001, seen: 2 },
      { id: 2002, seen: 2, inConversation: false },
    ]);
  });

  it('still asks for a reconnect when the connection expired', async () => {
    const { ctx } = setup({
      core_message_get_conversations: () => {
        throw new NeedsReconnect();
      },
    });
    await expect(searchPeople(ctx, { query: 'suzuki' })).rejects.toBeInstanceOf(NeedsReconnect);
  });

  it('rejects empty and oversized queries without calling Moodle', async () => {
    const { ctx, calls } = setup();
    await expect(searchPeople(ctx, { query: '   ' })).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchPeople(ctx, { query: 'x'.repeat(101) })).rejects.toThrow('too long');
    expect(calls).toEqual([]);
  });
});

describe('renderPeople', () => {
  const teacher = {
    id: 2001,
    name: ICHIRO,
    courses: ['Corporate Finance Basics'],
    inConversation: false,
    announcements: true,
    seen: 2,
  };
  const mate = {
    id: 2002,
    name: HANAKO,
    courses: ['Academic Writing'],
    inConversation: true,
    announcements: false,
    seen: 2,
  };

  it('prints ids, where each person was seen and who posts announcements', () => {
    const t = renderPeople({ query: 'suzuki', people: [teacher, mate], skippedForums: 0 });
    expect(t).toContain('2 people for "suzuki" (message one with prepare_message to_user_id):');
    expect(t).toContain(`- ${ICHIRO} — user_id 2001 — posts announcements (likely a teacher) — seen in: `);
    expect(t).toContain('seen in: Corporate Finance Basics');
    expect(t).toContain(`- ${HANAKO} — user_id 2002 — seen in: Academic Writing, conversation`);
    expect(t).not.toContain('not checked');
  });

  it('notes forums that were not checked', () => {
    const t = renderPeople({ query: 'suzuki', people: [mate], skippedForums: 2 });
    expect(t).toContain('1 person for "suzuki"');
    expect(t).toContain('(2 forums not checked; pass course_id to look at one course.)');
  });

  it('explains where people can be found when there is none', () => {
    const t = renderPeople({ query: 'zebra', people: [], skippedForums: 1 });
    expect(t).toContain('No people found for "zebra". Only people who posted in your course forums');
    expect(t).toContain('(1 forum not checked;');
  });
});
