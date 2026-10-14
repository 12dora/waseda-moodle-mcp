/** Moodle data, write-action approval and the activity log. */

import { Hono } from 'hono';
import { cancelAction, confirmAction, listActionRecords } from '../../core/services/actions';
import { getDueItems } from '../../core/services/due';
import { resolveScope } from '../../core/services/scope';
import { getCourseUpdates } from '../../core/services/sweep';
import { isoJst } from '../../core/time';
import type { ActionStatus } from '../../core/types';
import type { AppEnv } from '../auth';
import { consoleContext, intParam, oneOf, session, storeOf } from './shared';

const ACTION_STATUSES: readonly ActionStatus[] = ['pending', 'executed', 'cancelled', 'expired', 'failed'];
const MAX_COURSE_ID = 2_147_483_647;

export function dataRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/due', session, async (c) => {
    const ctx = await consoleContext(c, c.get('user'));
    const q = c.req.query();
    return c.json(
      await getDueItems(ctx, {
        daysAhead: intParam(q.days, 'days', { min: 1, max: 120 }) ?? 14,
        overdueDays: intParam(q.overdue_days, 'overdue_days', { min: 0, max: 60 }),
        courseId: intParam(q.course_id, 'course_id', { min: 1, max: MAX_COURSE_ID }),
      }),
    );
  });

  // every enrolled course with its kind / mine / suggested flags; the SPA's "My courses" page edits the scope
  app.get('/api/courses', session, async (c) => {
    const ctx = await consoleContext(c, c.get('user'));
    const { mode, courses } = await resolveScope(ctx);
    return c.json({ mode, courses });
  });

  app.get('/api/updates', session, async (c) => {
    const ctx = await consoleContext(c, c.get('user'));
    return c.json(
      await getCourseUpdates(ctx, { sinceDays: intParam(c.req.query('days'), 'days', { min: 1, max: 30 }) ?? 7 }),
    );
  });

  app.get('/api/actions', session, async (c) => {
    const ctx = await consoleContext(c, c.get('user'));
    const rawStatus = c.req.query('status');
    const status = rawStatus ? oneOf(rawStatus, ACTION_STATUSES, 'Unknown status.') : undefined;
    const limit = intParam(c.req.query('limit'), 'limit', { min: 1, max: 200 }) ?? 50;
    return c.json(await listActionRecords(ctx, { status, limit }));
  });

  app.post('/api/actions/:id/approve', session, async (c) => {
    const ctx = await consoleContext(c, c.get('user'));
    return c.json(await confirmAction(ctx, c.req.param('id'), 'console'));
  });

  app.post('/api/actions/:id/cancel', session, async (c) => {
    const ctx = await consoleContext(c, c.get('user'));
    return c.json(await cancelAction(ctx, c.req.param('id')));
  });

  app.get('/api/activity', session, async (c) => {
    const rows = await storeOf(c.env).listAudit(c.get('user').id, {
      limit: intParam(c.req.query('limit'), 'limit', { min: 1, max: 200 }) ?? 50,
      before: intParam(c.req.query('before'), 'before', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    });
    return c.json(
      rows.map((r) => ({
        id: r.id,
        at: isoJst(r.at),
        actor: r.actor,
        action: r.action,
        detail: r.detail ? JSON.stringify(r.detail).slice(0, 500) : null,
      })),
    );
  });

  return app;
}
