import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import { InvalidInput, MoodleError } from '../../src/core/errors';
import { openConditions, pageConditions } from '../../src/core/services/discover/conditions';
import { listIncomplete } from '../../src/core/services/discover/incomplete';
import { resolveScope } from '../../src/core/services/scope';
import type { Course } from '../../src/core/types';
import { makeFakeContext } from '../helpers/fake-context-be3';
import { createTestContext } from '../helpers/fake-context-be4';
import { fixture, makeWebApi, type WebApi } from './web-channel';

vi.mock('../../src/core/services/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/services/scope')>()),
  resolveScope: vi.fn(),
}));

const course = (id: number, name: string, mine: boolean): Course => ({
  id,
  name,
  shortName: name,
  category: null,
  url: `https://wsdmoodle.waseda.jp/course/view.php?id=${id}`,
  start: null,
  end: null,
  progress: null,
  kind: 'class',
  mine,
  suggested: mine,
  term: null,
  lastAccess: null,
});

const COURSES = [
  course(99101, '総合日本語３Ｘ', true),
  course(99102, 'Example Course', true),
  course(99103, 'Old Course', false),
];

beforeEach(() => {
  vi.mocked(resolveScope).mockReset();
  vi.mocked(resolveScope).mockResolvedValue({
    mode: 'mine',
    mine: new Set([99101, 99102]),
    courses: COURSES,
  });
});

type Raw = Record<string, unknown>;

const mod = (id: number, modname: string, completion: number, state: number, over: Raw = {}): Raw => ({
  id,
  name: `${modname} ${id}`,
  modname,
  url: `https://wsdmoodle.waseda.jp/mod/${modname}/view.php?id=${id}`,
  visible: 1,
  uservisible: true,
  completion,
  completiondata: completion === 0 ? undefined : { state, hascompletion: true },
  ...over,
});

const CONTENTS: Raw[] = [
  {
    id: 5002,
    name: '第1回',
    section: 1,
    modules: [
      mod(7101, 'millvi', 2, 0),
      mod(7102, 'millvi', 2, 1),
      mod(7103, 'resource', 1, 0),
      mod(7104, 'quiz', 2, 0),
      mod(7110, 'label', 0, 0),
      mod(7111, 'assign', 2, 0, { uservisible: false }),
    ],
  },
  { id: 5003, name: '第2回', section: 2, modules: [mod(7106, 'page', 2, 2)] },
];

function webContext(over: { spent?: number; contents?: (courseId: number) => unknown } = {}): {
  ctx: ServiceContext;
  api: WebApi;
} {
  const api = makeWebApi({
    spent: over.spent,
    pages: { '/course/view.php?id=99101': fixture('discover-course-ja.html') },
    handlers: {
      core_course_get_contents: (p: Raw) => (over.contents ?? (() => CONTENTS))(p.courseid as number),
    },
  });
  return { ctx: { ...createTestContext().ctx, moodle: async () => api }, api };
}

describe('listIncomplete on the web channel', () => {
  it('lists tracked activities that are not done, with the condition texts of the course page', async () => {
    const { ctx, api } = webContext({ contents: (id) => (id === 99101 ? CONTENTS : []) });
    const r = await listIncomplete(ctx);
    expect(r.courses).toHaveLength(1);
    const c = r.courses[0];
    expect(c).toMatchObject({ courseId: 99101, courseName: '総合日本語３Ｘ', done: 2, total: 5 });
    expect(c?.activities.map((a) => [a.cmid, a.kind, a.completion, a.conditions, a.sectionNumber, a.hidden])).toEqual([
      [7101, 'millvi', 'automatic', ['閲覧'], 1, false],
      [7103, 'resource', 'manual', [], 1, false],
      [7104, 'quiz', 'automatic', ['評点を受け取る'], 1, false], // the met condition is not listed
    ]);
    expect(c?.activities[0]).toMatchObject({ sectionName: '第1回', name: 'millvi 7101' });
    expect(r.skippedCourses).toEqual([]);
    expect(r.kinds).toBeNull();
    // only the selected (mine) courses are read; the course page came from the memo the adapter filled
    expect(api.calls.map((x) => x.params.courseid)).toEqual([99101, 99102]);
  });

  it('keeps courses whose tracked activities are all done, with their counts', async () => {
    const allDone = [{ id: 1, name: 'x', section: 0, modules: [mod(7102, 'page', 2, 1)] }];
    const { ctx } = webContext({ contents: () => allDone });
    const r = await listIncomplete(ctx, { courseId: 99102 });
    expect(r.courses).toEqual([{ courseId: 99102, courseName: 'Example Course', done: 1, total: 1, activities: [] }]);
  });

  it('filters by kind (case-insensitive) and counts only those kinds', async () => {
    const { ctx } = webContext({ contents: (id) => (id === 99101 ? CONTENTS : []) });
    const r = await listIncomplete(ctx, { kinds: ['MILLVI', ' millvi '] });
    expect(r.kinds).toEqual(['millvi']);
    expect(r.courses[0]).toMatchObject({ done: 1, total: 2 });
    expect(r.courses[0]?.activities.map((a) => a.cmid)).toEqual([7101]);
  });

  it('lists activities hidden from the student only with include_hidden', async () => {
    const { ctx } = webContext({ contents: (id) => (id === 99101 ? CONTENTS : []) });
    const r = await listIncomplete(ctx, { includeHidden: true });
    expect(r.courses[0]).toMatchObject({ done: 2, total: 6 });
    const hidden = r.courses[0]?.activities.find((a) => a.cmid === 7111);
    expect(hidden).toMatchObject({ hidden: true, kind: 'assign' });
  });

  it('reads one enrolled course outside the selection and refuses a course the user is not in', async () => {
    const { ctx, api } = webContext();
    await listIncomplete(ctx, { courseId: 99103 });
    expect(api.calls.map((x) => x.params.courseid)).toEqual([99103]);
    await expect(listIncomplete(ctx, { courseId: 55555 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(listIncomplete(ctx, { kinds: Array.from({ length: 11 }, (_, i) => `k${i}`) })).rejects.toBeInstanceOf(
      InvalidInput,
    );
  });

  it('names the courses the request budget could not cover (two requests per course on the web)', async () => {
    // 36 - 33 = 3 requests left: one course
    const { ctx, api } = webContext({ spent: 33 });
    const r = await listIncomplete(ctx);
    expect(api.calls.map((x) => x.params.courseid)).toEqual([99101]);
    expect(r.skippedCourses).toEqual([{ courseId: 99102, courseName: 'Example Course', reason: 'budget' }]);
  });

  it('skips a course Moodle refuses and still answers for the others', async () => {
    const { ctx } = webContext({
      contents: (id) => {
        if (id === 99102) throw new MoodleError('no access', 'nopermissions');
        return CONTENTS;
      },
    });
    const r = await listIncomplete(ctx);
    expect(r.courses.map((c) => c.courseId)).toEqual([99101]);
    expect(r.skippedCourses).toEqual([{ courseId: 99102, courseName: 'Example Course', reason: 'unreadable' }]);
  });

  it('does not stop when the course page cannot be read: the activities just have no condition text', async () => {
    const api = makeWebApi({ handlers: { core_course_get_contents: CONTENTS } });
    const ctx = { ...createTestContext().ctx, moodle: async () => api };
    const r = await listIncomplete(ctx, { courseId: 99101 });
    expect(r.courses[0]?.activities.map((a) => a.conditions)).toEqual([[], [], []]);
  });
});

describe('listIncomplete on the web-service channel', () => {
  it('takes the condition texts from the completion details and makes one call per course', async () => {
    const contents = [
      {
        id: 5002,
        name: 'Week 1',
        section: 1,
        modules: [
          mod(7101, 'millvi', 2, 0, {
            completiondata: {
              state: 0,
              hascompletion: true,
              details: [
                { rulename: 'completionview', rulevalue: { status: 0, description: 'View' } },
                { rulename: 'completionusegrade', rulevalue: { status: 1, description: 'Receive a grade' } },
              ],
            },
          }),
        ],
      },
    ];
    const { ctx, calls } = makeFakeContext({ core_course_get_contents: contents });
    const r = await listIncomplete(ctx, { courseId: 99101 });
    expect(calls.map((c) => c.fn)).toEqual(['core_course_get_contents']);
    expect(r.courses[0]?.activities[0]).toMatchObject({ cmid: 7101, conditions: ['View'], completion: 'automatic' });
  });
});

describe('completion condition texts', () => {
  it('reads the open conditions of the Japanese course page, not the met ones nor the hidden labels', () => {
    const found = pageConditions(fixture('discover-course-ja.html'));
    expect(found.get(7101)).toEqual(['閲覧']);
    expect(found.has(7102)).toBe(false); // met
    expect(found.has(7103)).toBe(false); // manual: no dropdown
    expect(found.get(7104)).toEqual(['評点を受け取る']);
  });

  it('reads the English page the same way and keeps a subsection apart from its modules', () => {
    const found = pageConditions(fixture('discover-course-en.html'));
    expect(found.get(7101)).toEqual(['View']);
    expect(found.get(7104)).toEqual(['Receive a grade']);
    expect(found.has(7105)).toBe(false); // the subsection has none of its own
    expect(found.get(7106)).toEqual(['View']);
  });

  it('returns the open web-service details, or all of them when none is marked open', () => {
    expect(
      openConditions([
        { rulevalue: { status: 1, description: 'View' } },
        { rulevalue: { status: 0, description: '<b>Submit</b>' } },
        { rulevalue: { description: '' } },
      ]),
    ).toEqual(['Submit']);
    expect(openConditions([{ rulevalue: { status: 1, description: 'View' } }])).toEqual(['View']);
    expect(openConditions(null)).toEqual([]);
  });
});
