import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MoodleError } from '../../src/core/errors';
import { renderForumSearch } from '../../src/core/mcp/render/forums';
import { listCourses } from '../../src/core/services/courses';
import { listDiscussions } from '../../src/core/services/forums-list';
import { searchForums } from '../../src/core/services/forums-search';
import { createTestContext } from '../helpers/fake-context-be4';
import { fixture, makeWebApi, type WebApi } from './web-channel';

/** Web channel: forum listing and search find the forum courses from the course structure and stay in budget. */

const COURSES = [
  { id: 99101, name: '総合日本語３Ｘ' },
  { id: 99102, name: 'Example Course' },
  { id: 99103, name: 'Example Seminar' },
];
let courses = COURSES;

vi.mock('../../src/core/services/courses', () => ({
  listCourses: vi.fn(async () => courses),
  listAllCourses: vi.fn(async () => courses),
}));

beforeEach(() => {
  courses = COURSES;
  vi.mocked(listCourses).mockClear();
});

type Raw = Record<string, unknown>;

/** A `core_courseformat_get_state` answer: `data` is a JSON string. */
const state = (cms: Array<{ id: number; module: string; section?: number; visible?: boolean }>) =>
  JSON.stringify({
    course: { id: '1' },
    cm: cms.map((c) => ({
      id: String(c.id),
      module: c.module,
      sectionnumber: c.section ?? 1,
      uservisible: c.visible ?? true,
    })),
  });

const STATES: Record<number, string> = {
  99101: state([
    { id: 7001, module: 'forum', section: 0 },
    { id: 7002, module: 'forum' },
    { id: 7009, module: 'hsuforum' },
  ]),
  99102: state([
    { id: 7101, module: 'forum', section: 0 },
    { id: 7102, module: 'assign' },
  ]),
  99103: state([
    { id: 7201, module: 'quiz' },
    { id: 7202, module: 'forum', visible: false },
  ]),
};

const forum = (id: number, cmid: number, course: number, over: Raw = {}): Raw => ({
  id,
  cmid,
  course,
  name: `Forum ${id}`,
  numdiscussions: 1,
  ...over,
});

/** Course overview answers: type unknown (web), tracking from the overview toggles. */
const FORUMS: Raw[] = [
  forum(8002, 7002, 99101, { istracked: true }),
  forum(8001, 7001, 99101, { istracked: false }),
  forum(8101, 7101, 99102, { istracked: false }),
];

const discussion = (id: number, subject: string, message: string | null): Raw => ({
  id: id * 10,
  discussion: id,
  subject,
  message,
  userfullname: '山田太郎',
  created: 1791860400,
  timemodified: 1791860400,
  numreplies: 0,
});

/** One discussion per forum (the web channel lists no first posts). */
const SUBJECTS: Record<number, string> = { 8001: '休講のお知らせ', 8002: 'Midterm questions', 8101: 'Welcome' };

function siteApi(over: { spent?: number; handlers?: Raw } = {}): WebApi {
  return makeWebApi({
    spent: over.spent,
    handlers: {
      core_courseformat_get_state: (p: Raw) => STATES[p.courseid as number] ?? state([]),
      mod_forum_get_forums_by_courses: (p: Raw) =>
        FORUMS.filter((f) => (p.courseids as number[]).includes(f.course as number)),
      mod_hsuforum_get_forums_by_courses: [],
      mod_forum_get_forum_discussions: (p: Raw) => {
        const subject = SUBJECTS[p.forumid as number];
        return { discussions: subject ? [discussion(p.forumid as number, subject, null)] : [] };
      },
      ...over.handlers,
    },
  });
}

function contextWith(api: WebApi) {
  const t = createTestContext();
  return { ...t.ctx, moodle: async () => api };
}

const callsTo = (api: WebApi, fn: string) => api.calls.filter((c) => c.fn === fn);

describe('listDiscussions on the web channel', () => {
  it('reads the course structures first and lists only the forum types each course has', async () => {
    const api = siteApi();
    const r = await listDiscussions(contextWith(api));
    expect(callsTo(api, 'core_courseformat_get_state').map((c) => c.params.courseid)).toEqual([99101, 99102, 99103]);
    // 99103 has no visible forum: no overview page; only 99101 has an Advanced Forum: one index page
    expect(callsTo(api, 'mod_forum_get_forums_by_courses').map((c) => c.params.courseids)).toEqual([[99101, 99102]]);
    expect(callsTo(api, 'mod_hsuforum_get_forums_by_courses').map((c) => c.params.courseids)).toEqual([[99101]]);
    expect(r.discussions.map((d) => d.discussionId).sort()).toEqual([8001, 8002, 8101]);
    expect(r.skippedForums).toBe(0);
  });

  it('leaves courses out when the call budget runs short and counts their forums as skipped', async () => {
    // 20 spent + 3 structure reads: 13 left, 6 kept for reading forums, 7 for the forum lists
    const api = siteApi({ spent: 20 });
    const r = await listDiscussions(contextWith(api));
    // 99101 costs 3 (overview, hsuforum index, the shared structure batch), 99102 costs 1
    expect(callsTo(api, 'mod_forum_get_forums_by_courses').map((c) => c.params.courseids)).toEqual([[99101, 99102]]);
    const tight = siteApi({ spent: 28 }); // 5 left: 3 for the lists, 2 for reading
    const t = await listDiscussions(contextWith(tight));
    expect(callsTo(tight, 'mod_forum_get_forums_by_courses').map((c) => c.params.courseids)).toEqual([[99101]]);
    expect(callsTo(tight, 'mod_forum_get_forum_discussions')).toHaveLength(2);
    expect(t.skippedForums).toBe(1); // 99102's forum, known from its structure
    expect(r.skippedForums).toBe(0);
  });

  it('treats a course whose structure Moodle refuses as possibly having both forum types', async () => {
    const api = siteApi({
      handlers: {
        core_courseformat_get_state: (p: Raw) => {
          if (p.courseid === 99102) throw new MoodleError('No access.', 'nopermissions');
          return STATES[p.courseid as number];
        },
      },
    });
    await listDiscussions(contextWith(api));
    expect(callsTo(api, 'mod_forum_get_forums_by_courses').map((c) => c.params.courseids)).toEqual([[99101, 99102]]);
    expect(callsTo(api, 'mod_hsuforum_get_forums_by_courses').map((c) => c.params.courseids)).toEqual([[99101, 99102]]);
  });
});

// ------------------------------------------------------------------ search: Moodle's search page per course

const QUERY = encodeURIComponent('レポート');
const searchPath = (course: number, page = 0) =>
  `/mod/forum/search.php?id=${course}&search=${QUERY}&perpage=20${page ? `&page=${page}` : ''}`;

const SEARCH_PAGES = {
  [searchPath(99101)]: fixture('forum-search-ja.html'),
  [searchPath(99101, 1)]: fixture('forum-search-page2-ja.html'),
  [searchPath(99102)]: fixture('forum-search-empty-ja.html'),
};

/** The site plus the search pages and 99101's Advanced Forum (one discussion whose subject matches). */
function searchApi(over: { spent?: number } = {}): WebApi {
  return makeWebApi({
    spent: over.spent,
    pages: SEARCH_PAGES,
    handlers: {
      core_courseformat_get_state: (p: Raw) => STATES[p.courseid as number] ?? state([]),
      mod_forum_get_forums_by_courses: (p: Raw) =>
        FORUMS.filter((f) => (p.courseids as number[]).includes(f.course as number)),
      mod_forum_get_forum_discussions: () => {
        throw new Error('the web search reads no discussion lists of standard forums');
      },
      mod_hsuforum_get_forums_by_courses: [forum(8009, 7009, 99101)],
      mod_hsuforum_get_forum_discussions_paginated: { discussions: [discussion(8009, 'レポート提出の確認', null)] },
    },
  });
}

describe('searchForums on the web channel', () => {
  it("uses Moodle's search page per course: every post, one hit per discussion, no discussion lists", async () => {
    const api = searchApi();
    const r = await searchForums(contextWith(api), { query: 'レポート' });
    // 99103 has no visible forum: not searched; 99101 has more results and fewer than 20 matched: page 2
    const gets = [searchPath(99101), searchPath(99102), searchPath(99101, 1)].map((p) => `GET ${p}`);
    expect(api.pageCalls).toEqual(gets);
    // the structures are read once, also for the Advanced Forum scan
    expect(callsTo(api, 'core_courseformat_get_state')).toHaveLength(3);
    expect(callsTo(api, 'mod_forum_get_forums_by_courses')).toHaveLength(0);
    expect(r.hits.map((h) => h.discussionId).sort()).toEqual([5001, 5002, 5003, 8009]);
    const thread = r.hits.find((h) => h.discussionId === 5001);
    expect(thread).toMatchObject({
      forumType: 'forum',
      forumCmid: 7002,
      forumName: '質問コーナー',
      courseName: '総合日本語３Ｘ',
      subject: '期末レポートについて',
      author: '鈴木花子',
      postId: 6003,
      firstPostId: 6001,
      matchingPosts: 2,
      replies: null,
      inSubject: true,
      createdAt: '2026-11-18T09:00:00+09:00',
      modifiedAt: '2026-11-20T10:38:31+09:00',
    });
    expect(thread?.snippet).toContain('レポートの長さは自由です。');
    const late = r.hits.find((h) => h.discussionId === 5002);
    expect(late?.inSubject).toBe(false);
    expect(late?.snippet).toMatch(/^…はじめに。.*参考文献はレポートの最後に書きます。& 以上$/);
    expect(r.hits.find((h) => h.discussionId === 8009)).toMatchObject({ forumType: 'hsuforum', replies: 0 });
    expect(r.fullText).toEqual({ courses: 2, skippedCourses: 0, cutCourses: 0, advancedForums: 1 });
    expect(r).not.toHaveProperty('bodyNote');
  });

  it('reads no second page once enough discussions matched and says which courses had more', async () => {
    const api = searchApi();
    const r = await searchForums(contextWith(api), { query: 'レポート', limit: 2 });
    expect(api.pageCalls).toEqual([`GET ${searchPath(99101)}`, `GET ${searchPath(99102)}`]);
    expect(r.hits).toHaveLength(2);
    expect(r.fullText).toMatchObject({ courses: 2, cutCourses: 1 });
  });

  it('searches one course with course_id and leaves courses out when the budget runs short', async () => {
    const one = searchApi();
    const r = await searchForums(contextWith(one), { query: 'レポート', courseId: 99102 });
    expect(one.pageCalls).toEqual([`GET ${searchPath(99102)}`]);
    expect(r.hits).toEqual([]);
    const empty = 'No forum posts match "レポート" (Moodle\'s search over every post of 1 course).';
    expect(renderForumSearch(r)).toContain(empty);
    // 32 spent + 3 structure reads: 1 left, one search page; nothing left for the Advanced Forum
    const tight = searchApi({ spent: 32 });
    const t = await searchForums(contextWith(tight), { query: 'レポート' });
    expect(tight.pageCalls).toEqual([`GET ${searchPath(99101)}`]);
    expect(t.fullText).toEqual({ courses: 1, skippedCourses: 1, cutCourses: 1, advancedForums: 0 });
    expect(t.skippedForums).toBe(1);
  });

  it('renders a search page hit with its newest matching post and no forum_id', async () => {
    const r = await searchForums(contextWith(searchApi()), { query: 'レポート' });
    const text = renderForumSearch(r);
    expect(text).toContain('- 期末レポートについて — newest match 鈴木花子, ');
    expect(text).toContain(
      '2 matching posts — 質問コーナー / 総合日本語３Ｘ (discussion_id 5001, post_id 6003, cmid 7002)',
    );
    expect(text).not.toContain('forum_id 0');
  });
});
