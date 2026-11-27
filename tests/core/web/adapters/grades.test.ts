import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CallHint, MoodleApi } from '../../../../src/core/context';
import { MoodleError } from '../../../../src/core/errors';
import { gradeFunctions } from '../../../../src/core/moodle/web/adapters/grades';
import type { WebSession } from '../../../../src/core/moodle/web/types';
import { mapCourseGrade, mapGradeItems } from '../../../../src/core/services/grades';
import { collectActivityGrades } from '../../../../src/core/services/grades-activity';
import { makeFakeWebSession } from '../../../helpers/fake-web-session';

const BASE = makeFakeWebSession({}).baseUrl;
const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../../fixtures/web', name), 'utf8').replaceAll('https://wsdmoodle.waseda.jp', BASE);

const OVERVIEW_PATH = '/grade/report/overview/index.php';
const userPath = (course: number) => `/course/user.php?mode=grade&id=${course}&user=4242`;

const call = <T>(web: WebSession, fn: string, params: Record<string, unknown>) => {
  const impl = gradeFunctions[fn];
  if (!impl) throw new Error(`no adapter for ${fn}`);
  return impl(web, params, {}) as Promise<T>;
};

type Overview = { grades: Parameters<typeof mapCourseGrade>[0][] };
type Items = {
  usergrades: Array<{ courseid: number; userid: number; gradeitems: NonNullable<Parameters<typeof mapGradeItems>[0]> }>;
};

const overview = (name: string) =>
  call<Overview>(
    makeFakeWebSession({ moodleUserId: 4242, pages: { [OVERVIEW_PATH]: fixture(name) } }),
    'gradereport_overview_get_course_grades',
    { userid: 4242 },
  );

const items = (name: string, course: number) =>
  call<Items>(
    makeFakeWebSession({ moodleUserId: 4242, pages: { [userPath(course)]: fixture(name) } }),
    'gradereport_user_get_grade_items',
    { courseid: course, userid: 4242 },
  );

describe('gradereport_overview_get_course_grades (web)', () => {
  it('reads one entry per course row and skips filler rows (ja)', async () => {
    const res = await overview('grades-overview-ja.html');
    expect(res.grades).toEqual([
      { courseid: 99101, grade: '-', rawgrade: null },
      { courseid: 99102, grade: '85.50', rawgrade: '85.50', rank: 3 },
    ]);
    const names = new Map([[99102, 'Example Course']]);
    expect(res.grades.map((g) => mapCourseGrade(g, names).raw)).toEqual([null, 85.5]);
  });

  it('accepts user report links and keeps a percentage as display text (en)', async () => {
    const res = await overview('grades-overview-en.html');
    expect(res.grades).toEqual([{ courseid: 99103, grade: '72.00 %', rawgrade: null }]);
  });

  it('is empty when the page has no table', async () => {
    const web = makeFakeWebSession({ pages: { [OVERVIEW_PATH]: '<div id="region-main"><p>No courses</p></div>' } });
    const res = await call<Overview>(web, 'gradereport_overview_get_course_grades', {});
    expect(res.grades).toEqual([]);
  });
});

describe('gradereport_user_get_grade_items (web)', () => {
  it('reads activity, manual and total rows of the user report (ja)', async () => {
    const res = await items('grades-user-ja.html', 99101);
    expect(res.usergrades[0]).toMatchObject({ courseid: 99101, userid: 4242 });
    const rows = res.usergrades[0]?.gradeitems ?? [];
    expect(rows.map((r) => [r.itemtype, r.itemname, r.itemmodule, r.cmid])).toEqual([
      ['course', null, undefined, undefined],
      ['mod', '第1回 & 確認', 'quiz', 7001],
      ['mod', '作文１', 'assign', 7002],
      ['manual', '授業参加', undefined, undefined],
      ['mod', '出席', 'attendance', undefined],
      ['category', null, undefined, undefined],
    ]);
    expect(rows[1]).toEqual({
      itemname: '第1回 & 確認',
      itemtype: 'mod',
      itemmodule: 'quiz',
      cmid: 7001,
      iteminstance: 7001,
      gradeformatted: '-',
      rangeformatted: '0–100',
      grademin: 0,
      grademax: 100,
      percentageformatted: '-',
      weightformatted: '20.00 % ( 空白 )',
      lettergradeformatted: '-',
      feedback: '',
    });
    expect(rows[2]).toMatchObject({ gradeformatted: '17.50', percentageformatted: '87.50 %' });
    expect(rows[2]?.feedback).toContain('<strong>できました</strong>');
    expect(rows[3]?.feedback).toBe('');
  });

  it('gives the shape the grade service maps: hidden values null, course total last', async () => {
    const res = await items('grades-user-ja.html', 99101);
    const mapped = mapGradeItems(res.usergrades[0]?.gradeitems);
    expect(mapped.map((i) => i.name)).toEqual([
      '第1回 & 確認',
      '作文１',
      '授業参加',
      '出席',
      'Category total',
      'Course total',
    ]);
    expect(mapped[0]).toMatchObject({ grade: null, percentage: null, feedback: null, range: '0–100' });
    expect(mapped[1]).toMatchObject({ grade: '17.50', feedback: 'よくできました。', cmid: 7002, modname: 'assign' });
  });

  it('omits the columns a report does not show (en)', async () => {
    const res = await items('grades-user-en.html', 99102);
    expect(res.usergrades[0]?.gradeitems).toEqual([
      {
        itemname: 'Essay',
        itemtype: 'mod',
        itemmodule: 'assign',
        cmid: 7011,
        iteminstance: 7011,
        gradeformatted: '8.00',
        rangeformatted: '0–10',
        grademin: 0,
        grademax: 10,
        feedback: '<div class="text_to_html">Good work.</div>',
      },
      {
        itemname: null,
        itemtype: 'course',
        gradeformatted: '8.00',
        rangeformatted: '0–10',
        grademin: 0,
        grademax: 10,
        feedback: '',
      },
    ]);
  });

  it.each([
    ['0.00&ndash;100.00', { grademin: 0, grademax: 100 }],
    ['0&ndash;4', { grademin: 0, grademax: 4 }],
    ['-5.50&ndash;5.50', { grademin: -5.5, grademax: 5.5 }],
  ])('reads the item minimum and maximum from the range %s', async (range, bounds) => {
    const page = fixture('grades-user-en.html').replaceAll('0&ndash;10', range);
    const web = makeFakeWebSession({ moodleUserId: 4242, pages: { [userPath(99102)]: page } });
    const res = await call<Items>(web, 'gradereport_user_get_grade_items', { courseid: 99102 });
    expect(res.usergrades[0]?.gradeitems[0]).toMatchObject(bounds);
  });

  it.each(['F&ndash;A+', '0.00 %&ndash;100.00 %', '-'])(
    'gives no minimum and maximum for the range %s',
    async (range) => {
      const page = fixture('grades-user-en.html').replaceAll('0&ndash;10', range);
      const web = makeFakeWebSession({ moodleUserId: 4242, pages: { [userPath(99102)]: page } });
      const res = await call<Items>(web, 'gradereport_user_get_grade_items', { courseid: 99102 });
      const item = res.usergrades[0]?.gradeitems[0];
      expect(item?.rangeformatted).toBeDefined();
      expect(item).not.toHaveProperty('grademin');
      expect(item).not.toHaveProperty('grademax');
    },
  );

  it('passes on the no-permission error of a hidden report', async () => {
    const web = makeFakeWebSession({
      moodleUserId: 4242,
      pages: {
        [userPath(99104)]: () => {
          throw new MoodleError('You do not currently have permissions.', 'nopermissions');
        },
      },
    });
    await expect(call(web, 'gradereport_user_get_grade_items', { courseid: 99104 })).rejects.toMatchObject({
      errorcode: 'nopermissions',
    });
  });

  it('does not report an unreadable page as an empty gradebook', async () => {
    const web = makeFakeWebSession({
      moodleUserId: 4242,
      pages: { [userPath(99105)]: '<div id="region-main"><p>Something else</p></div>' },
    });
    await expect(call(web, 'gradereport_user_get_grade_items', { courseid: 99105 })).rejects.toBeInstanceOf(
      MoodleError,
    );
  });
});

describe('activity grades of a hidden report (web)', () => {
  it('asks the list narrowed to a graded quiz for the maximum the course list lacks', async () => {
    const hints: Array<CallHint | undefined> = [];
    const answer = (fn: string, hint?: CallHint): unknown => {
      if (fn === 'mod_assign_get_assignments') return { courses: [] };
      if (fn === 'mod_quiz_get_user_best_grade') return { hasgrade: true, grade: 8 };
      hints.push(hint);
      return { quizzes: [{ id: 7001, coursemodule: 7001, name: '小テスト', grade: hint ? 10 : null }] };
    };
    const api = {
      call: async (fn: string, _params: unknown, hint?: CallHint) => answer(fn, hint),
    } as unknown as MoodleApi;
    const { items } = await collectActivityGrades(api, 99101);
    expect(items).toMatchObject([{ cmid: 7001, grade: '8.00 / 10.00', range: '0–10', percentage: '80.00 %' }]);
    expect(hints).toEqual([undefined, { cmid: 7001 }]);
  });
});
