/** Console "My courses" reads: overview aggregator and on-demand syllabus (contract §6.3), via the console cache. */

import { Hono } from 'hono';
import { InvalidInput } from '../../core/errors';
import { getCourseOverview, getSyllabusSummary } from '../../core/services/course-overview';
import type { AppEnv } from '../auth';
import { cachedRoute, cacheKey } from './console-cache';
import { consoleContext, intParam, MAX_COURSE_ID, session } from './shared';

export function coursesViewRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/courses/overview', session, (c) =>
    cachedRoute(
      c,
      cacheKey('/api/courses/overview'),
      async () => getCourseOverview(await consoleContext(c, c.get('user'))),
      { keep: (overview) => !overview.dueError },
    ),
  );

  app.get('/api/syllabus', session, (c) => {
    const courseId = intParam(c.req.query('course_id'), 'course_id', { min: 1, max: MAX_COURSE_ID });
    if (courseId === undefined) throw new InvalidInput('course_id is required.');
    return cachedRoute(
      c,
      cacheKey('/api/syllabus', { course_id: courseId }),
      async () => getSyllabusSummary(await consoleContext(c, c.get('user')), courseId),
      { keep: (summary) => summary.status !== 'error' },
    );
  });

  return app;
}
