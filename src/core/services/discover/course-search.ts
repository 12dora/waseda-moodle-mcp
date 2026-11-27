/**
 * search_courses: courses on Waseda Moodle matching a text (`core_course_search_courses`, ajax-enabled and a web
 * service function, so both channels). `enrolled` compares with the user's enrolled courses (one timeline call that
 * the course scope shares).
 */

import type { ServiceContext } from '../../context';
import { InvalidInput } from '../../errors';
import { decodeEntities } from '../../html';
import { fetchEnrolledCourses } from '../scope';
import { clampInt } from '../shared';
import type { CourseSearchResult, FoundCourse } from './types';

const SEARCH_FN = 'core_course_search_courses';
const PER_PAGE = 20;
const MAX_PAGE = 100;
const MAX_QUERY = 100;

interface RawFound {
  id?: number;
  fullname?: string;
  displayname?: string;
  shortname?: string;
  categoryname?: string | null;
}

interface RawSearch {
  courses?: RawFound[] | null;
  total?: number;
}

function toFound(raw: RawFound, baseUrl: string, enrolled: ReadonlySet<number>): FoundCourse[] {
  const id = Number(raw.id ?? 0);
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  const category = raw.categoryname ? decodeEntities(raw.categoryname) : '';
  return [
    {
      id,
      name: decodeEntities(raw.fullname || raw.displayname || ''),
      shortName: decodeEntities(raw.shortname ?? ''),
      category: category || null,
      url: `${baseUrl}/course/view.php?id=${id}`,
      enrolled: enrolled.has(id),
    },
  ];
}

/** One page (20) of the courses matching `query`; `page` is 0-based. */
export async function searchCourses(
  ctx: ServiceContext,
  query: string,
  opts: { page?: number } = {},
): Promise<CourseSearchResult> {
  const criteria = query.trim();
  if (criteria === '') throw new InvalidInput('The search text is empty.');
  if (criteria.length > MAX_QUERY) throw new InvalidInput(`The search text is longer than ${MAX_QUERY} characters.`);
  const page = clampInt(opts.page, 0, 0, MAX_PAGE);
  const api = await ctx.moodle();
  const [res, mine] = await Promise.all([
    api.call<RawSearch>(SEARCH_FN, { criterianame: 'search', criteriavalue: criteria, page, perpage: PER_PAGE }),
    fetchEnrolledCourses(api),
  ]);
  const enrolled = new Set(mine.map((c) => c.id));
  const courses = (res?.courses ?? []).flatMap((c) => toFound(c, api.baseUrl, enrolled));
  const total = Math.max(Number(res?.total ?? 0) || 0, courses.length);
  return {
    query: criteria,
    courses,
    total,
    page,
    pageSize: PER_PAGE,
    nextPage: (page + 1) * PER_PAGE < total ? page + 1 : null,
  };
}
