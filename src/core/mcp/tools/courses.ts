import * as z from 'zod';
import { getActivity } from '../../services/activity';
import { getCourseOutline, listCourses, searchCourseContent } from '../../services/courses';
import { getDueItems } from '../../services/due';
import { getGrades } from '../../services/grades';
import { renderActivity } from '../render/activity';
import { renderCourses, renderOutline, renderSearch } from '../render/courses';
import { renderDueList } from '../render/due';
import { renderGrades } from '../render/grades';
import { defineTool, id, limit, READ_HINTS } from './define';

const getDueItemsTool = defineTool({
  name: 'get_due_items',
  title: 'Due items',
  description:
    "Lists the user's outstanding assignments, quizzes, questionnaires and other deadlines, grouped as Overdue / Today / Tomorrow / Next 7 days / Later. " +
    'Use this first for "what is due", "what should I work on" or "did I miss anything"; already submitted assignments no longer appear. ' +
    'Times are JST, and a deadline at 00:00 means the previous day 24:00. Each line carries the cmid to pass to get_activity.',
  annotations: READ_HINTS,
  input: z.object({
    days_ahead: z
      .number()
      .int()
      .min(1)
      .max(120)
      .describe('How many days ahead to look. Default 14, max 120.')
      .optional(),
    overdue_days: z
      .number()
      .int()
      .min(0)
      .max(60)
      .describe('How many days back to include overdue items. Default 14, max 60.')
      .optional(),
    course_id: id('Only items of this course (see list_courses).').optional(),
  }),
  async run(ctx, a) {
    const r = await getDueItems(ctx, { daysAhead: a.days_ahead, overdueDays: a.overdue_days, courseId: a.course_id });
    return { text: renderDueList(r), data: r };
  },
});

const listCoursesTool = defineTool({
  name: 'list_courses',
  title: 'Courses',
  description:
    "Lists the user's Moodle courses with their course_id (needed by get_course, get_grades and the filters of other tools). " +
    'Defaults to courses in progress this term; use classification "past" or "all" for earlier ones. ' +
    'Courses the user hid in the console are omitted unless include_hidden is true.',
  annotations: READ_HINTS,
  input: z.object({
    classification: z
      .enum(['inprogress', 'future', 'past', 'all'])
      .describe('Which courses: inprogress (default), future, past or all.')
      .optional(),
    include_hidden: z.boolean().describe('Also list courses the user hid in settings. Default false.').optional(),
  }),
  async run(ctx, a) {
    const r = await listCourses(ctx, { classification: a.classification, includeHidden: a.include_hidden });
    return { text: renderCourses(r), data: { courses: r } };
  },
});

const getCourseTool = defineTool({
  name: 'get_course',
  title: 'Course outline',
  description:
    'Shows the sections and activities of one course (assignments, quizzes, forums, resources, videos, pages) with their cmid, dates, completion and file names. ' +
    'Use it to browse a course or to find a cmid; then call get_activity for details and file links. ' +
    'Pass section to see a single section of a long course.',
  annotations: READ_HINTS,
  input: z.object({
    course_id: id('Course id from list_courses.'),
    section: z
      .number()
      .int()
      .min(0)
      .describe('Only this section number (0 = the general section). Omit for all sections.')
      .optional(),
  }),
  async run(ctx, a) {
    const r = await getCourseOutline(ctx, a.course_id, { sectionNumber: a.section });
    return { text: renderOutline(r), data: r };
  },
});

const searchCourseContentTool = defineTool({
  name: 'search_course_content',
  title: 'Search course content',
  description:
    "Searches activity names, section names and file names across the user's current courses (or one course) and returns matching activities with their cmid. " +
    'Use it when the user asks for a lecture, slide, reading or assignment by topic or title. ' +
    'It matches names only, not the text inside files; the index refreshes automatically.',
  annotations: READ_HINTS,
  input: z.object({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe('Words to look for, e.g. "week 3 slides" or a file name. Case-insensitive.'),
    course_id: id('Restrict the search to this course.').optional(),
    limit: limit('Maximum number of hits. Default 20.', 50).optional(),
  }),
  async run(ctx, a) {
    const r = await searchCourseContent(ctx, a.query, { courseId: a.course_id, limit: a.limit });
    return { text: renderSearch(r, a.query), data: r };
  },
});

const getActivityTool = defineTool({
  name: 'get_activity',
  title: 'Activity details',
  description:
    "Returns the full detail of one activity by cmid: for assignments the instructions, dates, accepted submission types and limits, the user's submission status and feedback; " +
    'for quizzes the dates, attempts and grades; for forums recent discussions; for resources, pages and folders the description, body and file links. ' +
    'Call it before answering questions about requirements or before preparing a submission.',
  annotations: READ_HINTS,
  input: z.object({ cmid: id('Course module id (cmid) shown in due items, course outlines and search results.') }),
  async run(ctx, a) {
    const r = await getActivity(ctx, a.cmid);
    return { text: renderActivity(r), data: r };
  },
});

const getGradesTool = defineTool({
  name: 'get_grades',
  title: 'Grades',
  description:
    "Returns the user's grades. Pass course_id for per-course grades (collected from graded items, assignment feedback and quiz results); " +
    'Waseda hides the overall grade report, so without course_id the overview is usually empty and the result says so. ' +
    'Grades can only be read, never changed.',
  annotations: READ_HINTS,
  input: z.object({ course_id: id('Course id from list_courses. Recommended.').optional() }),
  async run(ctx, a) {
    const r = await getGrades(ctx, { courseId: a.course_id });
    return { text: renderGrades(r), data: r };
  },
});

export const courseTools = [
  getDueItemsTool,
  listCoursesTool,
  getCourseTool,
  searchCourseContentTool,
  getActivityTool,
  getGradesTool,
];
