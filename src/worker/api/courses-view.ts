/** Console "My courses" reads: overview aggregator and on-demand syllabus (contract §6.3). */

import { Hono } from 'hono';
import { InvalidInput } from '../../core/errors';
import { getCourseOverview, getSyllabusSummary } from '../../core/services/course-overview';
import type { AppEnv } from '../auth';
import { consoleContext, intParam, MAX_COURSE_ID, session } from './shared';

export function coursesViewRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/courses/overview', session, async (c) => {
    const ctx = await consoleContext(c, c.get('user'));
    return c.json(await getCourseOverview(ctx));
  });

  app.get('/api/syllabus', session, async (c) => {
    const ctx = await consoleContext(c, c.get('user'));
    const courseId = intParam(c.req.query('course_id'), 'course_id', { min: 1, max: MAX_COURSE_ID });
    if (courseId === undefined) throw new InvalidInput('course_id is required.');
    return c.json(await getSyllabusSummary(ctx, courseId));
  });

  return app;
}
