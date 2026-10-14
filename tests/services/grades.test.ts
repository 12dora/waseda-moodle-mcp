import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, MoodleUnavailable } from '../../src/core/errors';
import { cleanDisplay } from '../../src/core/services/grade-format';
import {
  GRADEBOOK_HIDDEN_HINT,
  getGrades,
  mapCourseGrade,
  mapGradeItem,
  mapGradeItems,
} from '../../src/core/services/grades';
import { mapAssignGrade, mapQuizGrade } from '../../src/core/services/grades-activity';
import fallback from '../fixtures/be2/grade_fallback.json';
import gradeItems from '../fixtures/be2/grade_items.json';
import overview from '../fixtures/be2/grades_overview.json';
import timeline from '../fixtures/be2/timeline_courses.json';
import { makeFakeContext } from '../helpers/fake-context';

const TIMELINE = 'core_course_get_enrolled_courses_by_timeline_classification';
const OVERVIEW = 'gradereport_overview_get_course_grades';
const ITEMS = 'gradereport_user_get_grade_items';
const ASSIGNMENTS = 'mod_assign_get_assignments';
const STATUS = 'mod_assign_get_submission_status';
const QUIZZES = 'mod_quiz_get_quizzes_by_courses';
const BEST = 'mod_quiz_get_user_best_grade';
const NOW = new Date('2026-10-20T00:00:00Z');
const NOW_SEC = NOW.getTime() / 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cleanDisplay', () => {
  it('turns Moodle placeholders into null and decodes entities', () => {
    expect(cleanDisplay('-')).toBeNull();
    expect(cleanDisplay('')).toBeNull();
    expect(cleanDisplay(null)).toBeNull();
    expect(cleanDisplay('&nbsp;')).toBeNull();
    expect(cleanDisplay(' 85.00 %')).toBe('85.00 %');
    expect(cleanDisplay('A &amp; B')).toBe('A & B');
  });
});

describe('mappers', () => {
  it('mapCourseGrade joins names and parses raw grades', () => {
    const names = new Map([[101, 'Finance']]);
    expect(mapCourseGrade({ courseid: 101, grade: '78.50', rawgrade: '78.50000' }, names)).toEqual({
      courseId: 101,
      courseName: 'Finance',
      grade: '78.50',
      raw: 78.5,
    });
    expect(mapCourseGrade({ courseid: 5, grade: '-', rawgrade: null }, names)).toEqual({
      courseId: 5,
      courseName: 'Course 5',
      grade: null,
      raw: null,
    });
  });

  it('mapGradeItem names unnamed totals and derives a range from min/max', () => {
    expect(mapGradeItem({ itemtype: 'course', gradeformatted: '50.00', grademin: 0, grademax: 80 })).toMatchObject({
      name: 'Course total',
      itemType: 'course',
      grade: '50.00',
      range: '0–80',
    });
    expect(mapGradeItem({ itemtype: 'category', itemname: null })).toMatchObject({
      name: 'Category total',
      grade: null,
    });
  });

  it('mapGradeItems drops ungraded categories and moves the course total last', () => {
    const items = mapGradeItems(gradeItems.usergrades[0]?.gradeitems);
    expect(items.map((i) => i.name)).toEqual([
      'Report 1',
      'Quiz A',
      'Midterm',
      'Participation & Attendance',
      'Course total',
    ]);
    expect(mapGradeItems(undefined)).toEqual([]);
  });
});

describe('getGrades', () => {
  it('returns the overview joined with course names', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [OVERVIEW]: overview, [TIMELINE]: timeline } });
    const res = await getGrades(ctx);
    expect(api.calls.find((c) => c.fn === OVERVIEW)?.params).toEqual({ userid: 1001 });
    expect(api.calls.find((c) => c.fn === TIMELINE)?.params).toEqual({
      classification: 'allincludinghidden',
      limit: 0,
    });
    expect(res).toEqual({
      overview: [
        { courseId: 101, courseName: 'Introduction to Finance & Accounting', grade: '78.50', raw: 78.5 },
        { courseId: 102, courseName: 'Seminar in Marketing', grade: null, raw: null },
        { courseId: 999, courseName: 'Course 999', grade: 'A', raw: 90 },
      ],
    });
  });

  it('returns the grade items of one course', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [ITEMS]: gradeItems, [TIMELINE]: timeline } });
    const res = await getGrades(ctx, { courseId: 101 });
    expect(api.calls.find((c) => c.fn === ITEMS)?.params).toEqual({ courseid: 101, userid: 1001 });
    if (!('course' in res)) throw new Error('expected a course result');
    expect(res.course).toMatchObject({ courseId: 101, courseName: 'Introduction to Finance & Accounting' });

    const [report, quiz, midterm, participation, total] = res.course.items;
    expect(report).toMatchObject({
      name: 'Report 1',
      itemType: 'mod',
      modname: 'assign',
      cmid: 5001,
      grade: '85.00',
      range: '0–100',
      percentage: '85.00 %',
      weight: '30.00 %',
      gradedAt: '2026-10-10T15:30:00+09:00',
    });
    expect(report?.feedback).toContain('Well done.');
    expect(quiz).toMatchObject({
      grade: null,
      percentage: null,
      feedback: null,
      gradedAt: null,
      range: '0–100',
      weight: null,
    });
    expect(midterm).toMatchObject({ itemType: 'category', grade: '70.00' });
    expect(participation).toMatchObject({
      name: 'Participation & Attendance',
      itemType: 'manual',
      modname: null,
      cmid: null,
      range: '0–10',
      gradedAt: '2026-10-09T07:53:20+09:00',
    });
    expect(total).toMatchObject({ name: 'Course total', itemType: 'course', grade: '78.50' });
  });

  it('falls back to a generic course name', async () => {
    const { ctx } = makeFakeContext({ responses: { [ITEMS]: { usergrades: [] }, [TIMELINE]: timeline } });
    await expect(getGrades(ctx, { courseId: 0 })).rejects.toBeInstanceOf(InvalidInput);
    expect(await getGrades(ctx, { courseId: 555 })).toEqual({
      course: { courseId: 555, courseName: 'Course 555', items: [] },
    });
  });

  it('returns an empty overview with a hint when Waseda hides the gradebook', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [OVERVIEW]: { grades: [], warnings: [] } } });
    expect(await getGrades(ctx)).toEqual({ overview: [], note: GRADEBOOK_HIDDEN_HINT });
    expect(api.count(TIMELINE)).toBe(0);
    expect(GRADEBOOK_HIDDEN_HINT).toBe(
      'Waseda Moodle hides the course grade report. Pass course_id to collect assignment and quiz grades.',
    );
  });

  it('treats a permission error on the overview like an empty one but rethrows others', async () => {
    const denied = makeFakeContext({ responses: { [OVERVIEW]: new MoodleError('x', 'nopermissiontoviewgrades') } });
    expect(await getGrades(denied.ctx)).toEqual({ overview: [], note: GRADEBOOK_HIDDEN_HINT });
    const broken = makeFakeContext({ responses: { [OVERVIEW]: new MoodleError('boom', 'invalidparameter') } });
    await expect(getGrades(broken.ctx)).rejects.toThrow('boom');
  });

  it('lets non-permission errors of the items call through', async () => {
    const { ctx } = makeFakeContext({
      responses: { [ITEMS]: new MoodleError('boom', 'invalidparameter'), [TIMELINE]: timeline },
    });
    await expect(getGrades(ctx, { courseId: 101 })).rejects.toThrow('boom');
  });
});

describe('getGrades activity fallback (gradebook hidden)', () => {
  const hidden = new MoodleError('You cannot view grades', 'nopermissiontoviewgrades');
  const responses = (over: Record<string, unknown> = {}) => ({
    [ITEMS]: hidden,
    [TIMELINE]: timeline,
    [ASSIGNMENTS]: fallback.assignments,
    [STATUS]: (p: Record<string, unknown>) => (fallback.statuses as Record<string, unknown>)[String(p.assignid)],
    [QUIZZES]: fallback.quizzes,
    [BEST]: (p: Record<string, unknown>) => (fallback.bestGrades as Record<string, unknown>)[String(p.quizid)],
    ...over,
  });

  it('collects assignment feedback and best quiz grades, newest due first, omitting ungraded ones', async () => {
    const { ctx, api } = makeFakeContext({ responses: responses() });
    const res = await getGrades(ctx, { courseId: 101 });
    if (!('course' in res)) throw new Error('expected a course result');

    expect(res.note).toContain('collected from assignment feedback and quiz results');
    expect(res.note).not.toContain('not checked');
    expect(res.note).not.toBe(GRADEBOOK_HIDDEN_HINT);
    expect(res.course).toMatchObject({ courseId: 101, courseName: 'Introduction to Finance & Accounting' });
    expect(res.course.items.map((i) => i.name)).toEqual(['Case & Memo', 'Report 1', 'Scale Task', 'Quiz A']);

    const [memo, report, scale, quiz] = res.course.items;
    expect(memo).toEqual({
      name: 'Case & Memo',
      itemType: 'mod',
      modname: 'assign',
      cmid: 5010,
      grade: '40.00 / 50.00',
      range: '0–50',
      percentage: '80.00 %',
      feedback: null,
      weight: null,
      gradedAt: '2026-10-09T07:53:20+09:00',
    });
    expect(report).toMatchObject({
      cmid: 5001,
      grade: '85.00 / 100.00',
      range: '0–100',
      percentage: '85.00 %',
      gradedAt: '2026-10-10T15:30:00+09:00',
    });
    expect(report?.feedback).toContain('Well done.');
    expect(scale).toMatchObject({ grade: 'Good', range: null, percentage: null, gradedAt: null });
    expect(quiz).toEqual({
      name: 'Quiz A',
      itemType: 'mod',
      modname: 'quiz',
      cmid: 5002,
      grade: '8.50 / 10.00',
      range: '0–10',
      percentage: '85.00 %',
      feedback: null,
      weight: null,
      gradedAt: null,
    });

    expect(api.calls.find((c) => c.fn === ASSIGNMENTS)?.params).toEqual({ courseids: [101] });
    expect(api.calls.find((c) => c.fn === QUIZZES)?.params).toEqual({ courseids: [101] });
    expect(
      api.calls
        .filter((c) => c.fn === STATUS)
        .map((c) => c.params.assignid)
        .sort(),
    ).toEqual([11, 12, 13, 14]);
    expect(
      api.calls
        .filter((c) => c.fn === BEST)
        .map((c) => c.params.quizid)
        .sort(),
    ).toEqual([21, 22]);
    expect(api.calls).toHaveLength(10); // items, courses, 2 lists, 4 statuses, 2 best grades
  });

  it('also falls back on the generic nopermissions code', async () => {
    const { ctx } = makeFakeContext({ responses: responses({ [ITEMS]: new MoodleError('x', 'nopermissions') }) });
    const res = await getGrades(ctx, { courseId: 101 });
    expect('course' in res && res.course.items.length).toBe(4);
  });

  const assignments = (n: number, due: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({ id: 100 + i, cmid: 6000 + i, name: `A${i}`, duedate: due(i), grade: 10 }));
  const quizzes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: 300 + i,
      coursemodule: 7000 + i,
      name: `Q${i}`,
      grade: 10,
      timeclose: 1000 + i,
    }));
  const graded = {
    [STATUS]: { feedback: { gradefordisplay: '5.00 / 10.00', gradeddate: 1791613800, grade: { grade: '5.0' } } },
    [BEST]: { hasgrade: true, grade: 1 },
  };
  const ids = (api: { calls: Array<{ fn: string; params: Record<string, unknown> }> }, fn: string, key: string) =>
    api.calls.filter((c) => c.fn === fn).map((c) => c.params[key] as number);

  it('stays within the call budget: 15 assignments + 10 quizzes, and reports what was not checked', async () => {
    const { ctx, api } = makeFakeContext({
      responses: responses({
        ...graded,
        [ASSIGNMENTS]: { courses: [{ id: 101, assignments: assignments(20, (i) => 1000 + i) }] },
        [QUIZZES]: { quizzes: quizzes(14) },
      }),
    });
    const res = await getGrades(ctx, { courseId: 101 });
    expect(api.count(STATUS)).toBe(15);
    expect(api.count(BEST)).toBe(10);
    expect(api.calls.length).toBeLessThanOrEqual(30);
    expect(ids(api, STATUS, 'assignid')).toContain(119); // newest deadline-passed first
    expect(ids(api, STATUS, 'assignid')).not.toContain(104);
    expect('course' in res && res.course.items).toHaveLength(25);
    expect(res.note).toContain('(9 items not checked)');
  });

  it('ranks deadline-passed assignments first, then undated, then upcoming; quizzes newest first', async () => {
    const due = (i: number) => {
      if (i < 10) return NOW_SEC - 1000 + i; // deadline passed
      if (i < 15) return 0; // no deadline
      return NOW_SEC + 1000 + i; // upcoming
    };
    const { ctx, api } = makeFakeContext({
      responses: responses({
        ...graded,
        [ASSIGNMENTS]: { courses: [{ id: 101, assignments: assignments(20, due) }] },
        [QUIZZES]: { quizzes: quizzes(12) },
      }),
    });
    const res = await getGrades(ctx, { courseId: 101 });
    const checked = ids(api, STATUS, 'assignid').sort((a, b) => a - b);
    expect(checked).toEqual(Array.from({ length: 15 }, (_, i) => 100 + i)); // past (100-109) + undated (110-114)
    const quizIds = ids(api, BEST, 'quizid');
    expect(quizIds).toContain(311);
    expect(quizIds).toContain(302);
    expect(quizIds).not.toContain(301);
    expect(res.note).toContain('(7 items not checked)');
  });

  it('gives unused quiz slots to assignments and vice versa', async () => {
    const onlyAssignments = makeFakeContext({
      responses: responses({
        ...graded,
        [ASSIGNMENTS]: { courses: [{ id: 101, assignments: assignments(30, (i) => 1000 + i) }] },
        [QUIZZES]: { quizzes: [] },
      }),
    });
    const a = await getGrades(onlyAssignments.ctx, { courseId: 101 });
    expect(onlyAssignments.api.count(STATUS)).toBe(25);
    expect(onlyAssignments.api.calls.length).toBeLessThanOrEqual(30);
    expect(a.note).toContain('(5 items not checked)');

    const mostlyQuizzes = makeFakeContext({
      responses: responses({
        ...graded,
        [ASSIGNMENTS]: { courses: [{ id: 101, assignments: assignments(5, (i) => 1000 + i) }] },
        [QUIZZES]: { quizzes: quizzes(30) },
      }),
    });
    const q = await getGrades(mostlyQuizzes.ctx, { courseId: 101 });
    expect(mostlyQuizzes.api.count(STATUS)).toBe(5);
    expect(mostlyQuizzes.api.count(BEST)).toBe(20);
    expect(q.note).toContain('(10 items not checked)');
  });

  it('skips activities whose calls fail with a Moodle error', async () => {
    const { ctx } = makeFakeContext({
      responses: responses({
        [STATUS]: new MoodleError('nope', 'nopermission'),
        [QUIZZES]: new MoodleError('module disabled', 'accessexception'),
      }),
    });
    const res = await getGrades(ctx, { courseId: 101 });
    expect(res).toMatchObject({ course: { courseId: 101, items: [] } });
  });

  it('skips activities that are temporarily unavailable', async () => {
    const { ctx } = makeFakeContext({
      responses: responses({ [STATUS]: new MoodleUnavailable(), [BEST]: new MoodleUnavailable() }),
    });
    const res = await getGrades(ctx, { courseId: 101 });
    expect(res).toMatchObject({ course: { courseId: 101, items: [] } });
  });

  it('mapAssignGrade / mapQuizGrade handle ungraded and raw-only cases', () => {
    expect(
      mapAssignGrade({ id: 1, grade: 100 }, { feedback: { gradefordisplay: '-', grade: { grade: '-1.00000' } } }),
    ).toBeNull();
    expect(mapAssignGrade({ id: 1, grade: 100 }, {})).toBeNull();
    expect(mapAssignGrade({ id: 1, grade: 100 }, { feedback: { grade: { grade: '' } } })).toBeNull();
    const commentsOnly = mapAssignGrade(
      { id: 1, name: 'Essay', cmid: 9, grade: 100 },
      {
        feedback: {
          gradefordisplay: '-',
          plugins: [{ type: 'comments', editorfields: [{ text: '<p>Needs work</p>' }] }],
        },
      },
    );
    expect(commentsOnly).toMatchObject({ name: 'Essay', cmid: 9, grade: null, percentage: null });
    expect(commentsOnly?.feedback).toContain('Needs work');
    expect(
      mapAssignGrade({ id: 1, name: 'X', grade: 20 }, { feedback: { grade: { grade: '15.00000' } } }),
    ).toMatchObject({
      grade: '15.00',
      range: '0–20',
      percentage: '75.00 %',
    });
    expect(mapQuizGrade({ id: 1, grade: 10 }, { hasgrade: false })).toBeNull();
    expect(mapQuizGrade({ id: 1, name: 'Q' }, { hasgrade: true, grade: 3 })).toMatchObject({
      grade: '3.00',
      range: null,
      percentage: null,
    });
  });
});
