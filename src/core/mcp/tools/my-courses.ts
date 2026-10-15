import * as z from 'zod';
import { setMyCourses } from '../../services/scope';
import { getCourseUpdates } from '../../services/sweep';
import { renderCourseUpdates, renderMyCourses } from '../render/updates';
import { courseUpdatesOut, mySettingsOut } from '../schemas/my-courses';
import { defineTool, id, LOCAL_SETTING_HINTS, READ_HINTS } from './define';

const DEFAULT_SINCE_DAYS = 7;

const setMyCoursesTool = defineTool({
  name: 'set_my_courses',
  title: 'Set course selection',
  description:
    "Saves the course selection (This term's courses): which courses the user attends this term. " +
    'Assignments & deadlines, course lists, searches and updates then only cover these courses. ' +
    'Use it after the user confirms the courses (list_courses shows the candidates and marks suggestions); never guess. ' +
    'Pass null to go back to the automatic suggestion. This only changes the selection kept by this server, nothing in Moodle.',
  annotations: LOCAL_SETTING_HINTS,
  input: z.object({
    course_ids: z
      .array(id('A course_id from list_courses.'))
      .min(1)
      .max(60)
      .nullable()
      .describe('The course_ids the user attends this term, or null to return to the automatic suggestion.'),
  }),
  output: mySettingsOut,
  async run(ctx, a) {
    const r = await setMyCourses(ctx, a.course_ids);
    return { text: renderMyCourses(r.myCourseIds), data: r };
  },
});

const getCourseUpdatesTool = defineTool({
  name: 'get_course_updates',
  title: 'Course updates',
  description:
    "Lists what teachers added or changed recently in the user's courses (new assignments, slides, pages, files), grouped by course, newest first. " +
    'Use it for "anything new?" or "what did the teacher post"; then open an item with get_activity (cmid) to read it. ' +
    'Covers the confirmed courses only unless course_id is given.',
  annotations: READ_HINTS,
  input: z.object({
    since_days: z
      .number()
      .int()
      .min(1)
      .max(60)
      .describe(`How many days back to look. Default ${DEFAULT_SINCE_DAYS}, max 60.`)
      .optional(),
    course_id: id('Only this course (see list_courses).').optional(),
  }),
  output: courseUpdatesOut,
  async run(ctx, a) {
    const r = await getCourseUpdates(ctx, { sinceDays: a.since_days, courseId: a.course_id });
    return { text: renderCourseUpdates(r, a.since_days ?? DEFAULT_SINCE_DAYS), data: r };
  },
});

export const myCoursesTools = [setMyCoursesTool, getCourseUpdatesTool];
