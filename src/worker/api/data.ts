/** Moodle data, write-action approval and the activity log. */

import { type Context, Hono } from 'hono';
import { InvalidInput } from '../../core/errors';
import { cancelAction, confirmAction, listActionRecords } from '../../core/services/actions';
import { getDueItems } from '../../core/services/due';
import { resolveScope } from '../../core/services/scope';
import { getCourseUpdates } from '../../core/services/sweep';
import { getTimetable } from '../../core/services/timetable';
import { isoJst, nowMs } from '../../core/time';
import type { ActionStatus } from '../../core/types';
import type { AppEnv } from '../auth';
import { cachedRoute, cacheKey } from './console-cache';
import { consoleContext, intParam, MAX_COURSE_ID, oneOf, session, storeOf } from './shared';

const ACTION_STATUSES: readonly ActionStatus[] = [
  'pending',
  'executed',
  'cancelled',
  'expired',
  'failed',
  'superseded',
];

const DAY_MS = 86_400_000;
const TIMETABLE_DATE = /^(today|tomorrow|\d{4}-\d{2}-\d{2})$/;

/** The options of GET /api/due and the cache key they make (one stored answer per user and query). */
function dueQuery(q: Record<string, string>) {
  const opts = {
    daysAhead: intParam(q.days, 'days', { min: 1, max: 120 }) ?? 14,
    overdueDays: intParam(q.overdue_days, 'overdue_days', { min: 0, max: 60 }),
    courseId: intParam(q.course_id, 'course_id', { min: 1, max: MAX_COURSE_ID }),
  };
  const key = cacheKey('/api/due', { days: opts.daysAhead, overdue_days: opts.overdueDays, course_id: opts.courseId });
  return { opts, key };
}

/**
 * The timetable's first day as a date: 'today' / 'tomorrow' / none resolve to the JST date, so the cache key names the
 * day the answer is for (a copy made yesterday for "today" is not today's). The year range is checked by the service.
 */
function timetableDate(raw: string | undefined): string {
  if (raw && !TIMETABLE_DATE.test(raw)) throw new InvalidInput("date must be 'today', 'tomorrow' or YYYY-MM-DD.");
  if (!raw || raw === 'today') return isoJst(nowMs()).slice(0, 10);
  if (raw === 'tomorrow') return isoJst(nowMs() + DAY_MS).slice(0, 10);
  return raw;
}

/**
 * GET /api/due through the console cache (console-cache.ts). The sweep reads the course snapshots the hourly cron keeps
 * (no live course pages), so even a refresh stays short. MCP get_due_items stays live.
 */
async function dueRoute(c: Context<AppEnv>) {
  const { opts, key } = dueQuery(c.req.query());
  return cachedRoute(c, key, async () =>
    getDueItems(await consoleContext(c, c.get('user')), { ...opts, sweep: 'cached' }),
  );
}

async function updatesRoute(c: Context<AppEnv>) {
  const q = c.req.query();
  const courseId = intParam(q.course_id, 'course_id', { min: 1, max: MAX_COURSE_ID });
  const sinceDays = intParam(q.days, 'days', { min: 1, max: 30 }) ?? 7;
  return cachedRoute(c, cacheKey('/api/updates', { days: sinceDays, course_id: courseId }), async () =>
    getCourseUpdates(await consoleContext(c, c.get('user')), {
      sinceDays,
      ...(courseId === undefined ? {} : { courseId }),
    }),
  );
}

async function timetableRoute(c: Context<AppEnv>) {
  const q = c.req.query();
  const date = timetableDate(q.date || undefined);
  const days = intParam(q.days, 'days', { min: 1, max: 14 }) ?? 1;
  return cachedRoute(c, cacheKey('/api/timetable', { date, days }), async () =>
    getTimetable(await consoleContext(c, c.get('user')), { date, days }),
  );
}

export function dataRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/due', session, dueRoute);

  // every enrolled course with its kind / mine / suggested flags; Settings → This term's courses edits the scope
  app.get('/api/courses', session, (c) =>
    cachedRoute(c, cacheKey('/api/courses'), async () => {
      const { mode, courses } = await resolveScope(await consoleContext(c, c.get('user')));
      return { mode, courses };
    }),
  );

  app.get('/api/updates', session, updatesRoute);
  app.get('/api/timetable', session, timetableRoute);

  app.get('/api/actions', session, async (c) => {
    const ctx = await consoleContext(c, c.get('user'));
    const rawStatus = c.req.query('status');
    const status = rawStatus ? oneOf(rawStatus, ACTION_STATUSES, 'Unknown status.') : undefined;
    const limit = intParam(c.req.query('limit'), 'limit', { min: 1, max: 200 }) ?? 50;
    return c.json(await listActionRecords(ctx, { status, limit }));
  });

  app.post('/api/actions/:id/approve', session, async (c) => {
    const user = c.get('user');
    const result = await confirmAction(await consoleContext(c, user, { mail: true }), c.req.param('id'), 'console');
    // a submission, completion or post changes the due list and the updates: the next console read computes again
    if (result.status === 'executed') await storeOf(c.env).clearConsoleCache(user.id);
    return c.json(result);
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
