import { describe, expect, it } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import { searchCourses } from '../../src/core/services/discover/course-search';
import { makeFakeContext } from '../helpers/fake-context-be3';

const TIMELINE = 'core_course_get_enrolled_courses_by_timeline_classification';

const found = (id: number, fullname: string, over: Record<string, unknown> = {}) => ({
  id,
  fullname,
  displayname: fullname,
  shortname: `C${id}`,
  categoryname: 'Law &amp; Society',
  courseimage: '',
  ...over,
});

function setup(search: unknown) {
  return makeFakeContext({
    core_course_search_courses: search,
    [TIMELINE]: { courses: [{ id: 99101, fullname: '総合日本語３Ｘ', shortname: 'JP3X' }] },
  });
}

describe('searchCourses', () => {
  it('maps the matches and marks the courses the user is enrolled in', async () => {
    const { ctx, calls } = setup({
      courses: [found(99101, '総合日本語３Ｘ'), found(99103, 'Example Seminar', { categoryname: null })],
      total: 2,
    });
    const r = await searchCourses(ctx, '  日本語 ');
    expect(calls.find((c) => c.fn === 'core_course_search_courses')?.params).toEqual({
      criterianame: 'search',
      criteriavalue: '日本語',
      page: 0,
      perpage: 20,
    });
    expect(r.courses).toEqual([
      {
        id: 99101,
        name: '総合日本語３Ｘ',
        shortName: 'C99101',
        category: 'Law & Society',
        url: 'https://moodle.example.com/course/view.php?id=99101',
        enrolled: true,
      },
      {
        id: 99103,
        name: 'Example Seminar',
        shortName: 'C99103',
        category: null,
        url: 'https://moodle.example.com/course/view.php?id=99103',
        enrolled: false,
      },
    ]);
    expect(r).toMatchObject({ query: '日本語', total: 2, page: 0, pageSize: 20, nextPage: null });
  });

  it('pages: the next page exists while the total reaches past this one', async () => {
    const { ctx, calls } = setup({ courses: [found(99103, 'Example Seminar')], total: 45 });
    const first = await searchCourses(ctx, 'seminar', { page: 1 });
    expect(calls.find((c) => c.fn === 'core_course_search_courses')?.params.page).toBe(1);
    expect(first.nextPage).toBe(2);
    const last = await searchCourses(setup({ courses: [found(99103, 'Example Seminar')], total: 45 }).ctx, 'seminar', {
      page: 2,
    });
    expect(last.nextPage).toBeNull();
  });

  it('drops entries without a usable id and survives an empty answer', async () => {
    const r = await searchCourses(setup({ courses: [{ fullname: 'No id' }], total: 1 }).ctx, 'x');
    expect(r.courses).toEqual([]);
    expect(r.total).toBe(1);
    const none = await searchCourses(setup({ courses: [], total: 0 }).ctx, 'x');
    expect(none).toMatchObject({ courses: [], total: 0, nextPage: null });
  });

  it('refuses an empty or oversized query', async () => {
    const { ctx } = setup({ courses: [], total: 0 });
    await expect(searchCourses(ctx, '   ')).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchCourses(ctx, 'x'.repeat(101))).rejects.toBeInstanceOf(InvalidInput);
  });
});
