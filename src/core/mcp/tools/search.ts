import * as z from 'zod';
import { searchForums } from '../../services/forums-search';
import { renderForumSearch } from '../render/forums';
import { forumSearchOut } from '../schemas/search';
import { defineTool, id, limit, READ_HINTS } from './define';

const searchForumsTool = defineTool({
  name: 'search_forums',
  title: 'Search forums',
  description:
    'Finds forum discussions by keyword in the subject or the first post, across the forums of the current courses (or one course). ' +
    'All words must occur (any case); only the newest discussions of each forum are searched, announcements first. ' +
    'Open a result with get_discussion using its forum_type and discussion_id. ' +
    'Set include_messages to also search the private messages (best effort).',
  annotations: READ_HINTS,
  input: z.object({
    query: z.string().trim().min(1).max(200).describe('Words to look for, separated by spaces; all must match.'),
    course_id: id('Only forums of this course.').optional(),
    include_messages: z.boolean().describe('Also search private messages. Default false.').optional(),
    limit: limit('Maximum discussions. Default 20.', 50).optional(),
  }),
  output: forumSearchOut,
  async run(ctx, a) {
    const r = await searchForums(ctx, {
      query: a.query,
      courseId: a.course_id,
      includeMessages: a.include_messages,
      limit: a.limit,
    });
    return { text: renderForumSearch(r), data: r };
  },
});

export const searchTools = [searchForumsTool];
