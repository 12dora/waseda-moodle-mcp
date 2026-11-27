import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallHint } from '../../src/core/context';
import { MoodleError } from '../../src/core/errors';
import { listCourses } from '../../src/core/services/courses';
import { listDiscussions } from '../../src/core/services/forums-list';
import { searchForums } from '../../src/core/services/forums-search';
import { createTestContext } from '../helpers/fake-context-be4';
import { makeWebApi, type WebApi } from './web-channel';

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

/** One discussion per forum; the first post only with the `messages` hint (as the web adapter answers). */
const BODIES: Record<number, { subject: string; body: string }> = {
  8001: { subject: '休講のお知らせ', body: '<p>来週の midterm は延期します。</p>' },
  8002: { subject: 'Midterm questions', body: '<p>Ask here.</p>' },
  8101: { subject: 'Welcome', body: '<p>See the midterm schedule.</p>' },
};

function siteApi(over: { spent?: number; handlers?: Raw } = {}): WebApi {
  return makeWebApi({
    spent: over.spent,
    handlers: {
      core_courseformat_get_state: (p: Raw) => STATES[p.courseid as number] ?? state([]),
      mod_forum_get_forums_by_courses: (p: Raw) =>
        FORUMS.filter((f) => (p.courseids as number[]).includes(f.course as number)),
      mod_hsuforum_get_forums_by_courses: [],
      mod_forum_get_forum_discussions: (p: Raw, hint?: CallHint) => {
        const d = BODIES[p.forumid as number];
        return { discussions: d ? [discussion(p.forumid as number, d.subject, hint?.messages ? d.body : null)] : [] };
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

describe('searchForums on the web channel', () => {
  it('searches first posts only of untracked forums and says which were searched by subject', async () => {
    const api = siteApi();
    const r = await searchForums(contextWith(api), { query: 'midterm' });
    const hints = Object.fromEntries(
      callsTo(api, 'mod_forum_get_forum_discussions').map((c) => [c.params.forumid, c.hint?.messages === true]),
    );
    // 8002 is tracked: reading its first posts would mark them read
    expect(hints).toEqual({ 8001: true, 8002: false, 8101: true });
    expect(r.hits.map((h) => h.discussionId).sort()).toEqual([8001, 8002, 8101]);
    const subjectHit = r.hits.find((h) => h.discussionId === 8002);
    expect(subjectHit?.snippet).toBe('Midterm questions');
    expect(r.hits.find((h) => h.discussionId === 8001)?.snippet).toContain('midterm は延期');
    expect(r.bodyNote).toContain('1 forum was searched by subject only');
  });

  it('reads the likely announcement forums (first forum of section 0) first', async () => {
    const api = siteApi();
    await searchForums(contextWith(api), { query: 'midterm' });
    const order = callsTo(api, 'mod_forum_get_forum_discussions').map((c) => c.params.forumid);
    expect(order.slice(0, 2).sort()).toEqual([8001, 8101]);
    expect(order[2]).toBe(8002);
  });

  it('reads no first posts when the budget has no room for them', async () => {
    // 2 left after the structures: 99102's forum list and its forum read, none for first posts (99101 left out)
    const api = siteApi({ spent: 31 });
    const r = await searchForums(contextWith(api), { query: 'welcome' });
    expect(callsTo(api, 'mod_forum_get_forum_discussions').every((c) => c.hint?.messages !== true)).toBe(true);
    expect(r.bodyNote).toMatch(/searched by subject only/);
  });
});
