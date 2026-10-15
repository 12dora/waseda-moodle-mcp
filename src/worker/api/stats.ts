/** Operator-only usage statistics (aggregate counters; see store/usage-report.ts). */

import { Hono } from 'hono';
import { NotFound } from '../../core/errors';
import type { AppEnv } from '../auth';
import { adminMoodleUserIds } from '../env';
import { oneOf, session, storeOf } from './shared';

const RANGES = ['7', '30', '90'] as const;

export function statsRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // everyone who is not an operator gets the same 404 as an unknown route
  app.get('/api/admin/stats', session, async (c) => {
    if (!adminMoodleUserIds(c.env).has(c.get('user').moodleUserId)) throw new NotFound('Not found.');
    const raw = c.req.query('days');
    const days = Number(oneOf(raw === undefined || raw === '' ? '30' : raw, RANGES, 'days must be 7, 30 or 90.'));
    return c.json(await storeOf(c.env).getUsageStats(days, Date.now()));
  });

  return app;
}
