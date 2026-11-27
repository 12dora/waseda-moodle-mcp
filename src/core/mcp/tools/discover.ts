import * as z from 'zod';
import { searchCourses } from '../../services/discover/course-search';
import { listIncomplete } from '../../services/discover/incomplete';
import { listMyPosts } from '../../services/discover/my-posts';
import { renderCourseSearch, renderIncomplete, renderMyPosts } from '../render/discover';
import { list } from '../schemas/common';
import { defineTool, id, READ_HINTS } from './define';

const incompleteOut = z.looseObject({
  courses: list({
    courseId: z.number(),
    courseName: z.string(),
    done: z.number(),
    total: z.number(),
    activities: list({ cmid: z.number(), name: z.string(), kind: z.string(), conditions: z.array(z.string()) }),
  }),
  skippedCourses: list({ courseId: z.number(), reason: z.string() }),
});

const myPostsOut = z.looseObject({
  posts: list({
    postId: z.number(),
    discussionId: z.number(),
    discussionSubject: z.string(),
    postSubject: z.string(),
    isDiscussionStart: z.boolean(),
  }),
  page: z.number(),
  nextPage: z.number().nullable(),
});

const courseSearchOut = z.looseObject({
  query: z.string(),
  courses: list({ id: z.number(), name: z.string(), enrolled: z.boolean() }),
  total: z.number(),
  page: z.number(),
  nextPage: z.number().nullable(),
});

const page = (describe: string) => z.number().int().min(0).max(1000).describe(describe);

const listIncompleteTool = defineTool({
  name: 'list_incomplete',
  title: 'Unfinished activities',
  description:
    'Lists the activities with completion tracking that the user has NOT finished yet, per course, with how many are done ' +
    'of all tracked ones and what Moodle still asks (e.g. "View", "Submit"). Use it for "what have I not watched / ' +
    'opened / handed in yet". Default: the current courses; pass course_id for one course. Pass kinds to narrow ' +
    'the activity types, e.g. ["millvi"] for on-demand videos, "resource", "quiz", "assign". It only reads the course ' +
    'structure and opens no activity, so nothing is marked as viewed. Courses beyond the request budget are named as ' +
    'skipped; repeat with course_id for those.',
  annotations: READ_HINTS,
  input: z.object({
    course_id: id('Only this enrolled course (default: the current courses).').optional(),
    kinds: z
      .array(z.string().trim().min(1).max(40))
      .max(10)
      .describe('Only these activity types (Moodle module names): millvi = on-demand video, resource, quiz, assign, …')
      .optional(),
    include_hidden: z
      .boolean()
      .describe('Also list activities hidden from the student view or not yet available. Default false.')
      .optional(),
  }),
  output: incompleteOut,
  async run(ctx, a) {
    const r = await listIncomplete(ctx, { courseId: a.course_id, kinds: a.kinds, includeHidden: a.include_hidden });
    return { text: renderIncomplete(r), data: r };
  },
});

const listMyPostsTool = defineTool({
  name: 'list_my_posts',
  title: 'My forum posts',
  description:
    "Lists the user's own forum posts, as Moodle orders them (most recently changed first): course, forum, discussion " +
    'subject, post subject, date, whether it started the discussion or replied, with discussion_id and post_id. ' +
    'Use it for "what did I post / did I already answer". Pass course_id for one course and page for older posts. ' +
    'It reads a listing page that marks nothing read. Open a thread with get_discussion. ' +
    'Only available through the Moodle web session.',
  annotations: READ_HINTS,
  input: z.object({
    course_id: id('Only posts in this course.').optional(),
    page: page('Page of posts (0 is the first); use the page the output names. Default 0.').optional(),
  }),
  output: myPostsOut,
  async run(ctx, a) {
    const r = await listMyPosts(ctx, { courseId: a.course_id, page: a.page });
    return { text: renderMyPosts(r), data: r };
  },
});

const searchCoursesTool = defineTool({
  name: 'search_courses',
  title: 'Search courses',
  description:
    'Searches ALL courses on Waseda Moodle by text (course name, code, description), 20 per page, and shows whether the ' +
    'user is already enrolled in each. Use it to find a course the user is not in, or to look up a course id. ' +
    "For content inside the user's own courses use search_course_content instead.",
  annotations: READ_HINTS,
  input: z.object({
    query: z.string().trim().min(1).max(100).describe('Words to look for, e.g. a course name or code.'),
    page: page('Page of results (0 is the first). Default 0.').optional(),
  }),
  output: courseSearchOut,
  async run(ctx, a) {
    const r = await searchCourses(ctx, a.query, { page: a.page });
    return { text: renderCourseSearch(r), data: r };
  },
});

export const discoverTools = [listIncompleteTool, listMyPostsTool, searchCoursesTool];
