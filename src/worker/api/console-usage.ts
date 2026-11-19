/**
 * Console usage statistics: user-initiated, authenticated console API requests count as `web` activity and, per
 * feature of a fixed vocabulary, as page usage. Background requests (BACKGROUND_HEADER) and unmapped routes do not.
 */

import type { MiddlewareHandler } from 'hono';
import type { UserRow } from '../../core/context';
import { type AppEnv, deferOn, isBackgroundRequest } from '../auth';
import { storeOf } from './shared';

/** Ordered, first match wins: `METHOD path` patterns -> feature label (the whole vocabulary of the `page` counter). */
const FEATURES: readonly (readonly [RegExp, string])[] = [
  [/^GET \/api\/me$/, 'open'], // once per console load (the session check every page starts with)
  [/^DELETE \/api\/me$/, 'account'],
  [/^PATCH \/api\/settings$/, 'settings'],
  [/^GET \/api\/due$/, 'due'],
  [/^GET \/api\/updates$/, 'updates'],
  [/^GET \/api\/timetable$/, 'timetable'],
  [/^GET \/api\/courses\/overview$/, 'courses'],
  [/^GET \/api\/syllabus$/, 'course_view'],
  [/^GET \/api\/courses$/, 'course_selection'],
  [/^\w+ \/api\/actions(\/|$)/, 'approvals'],
  [/^GET \/api\/activity$/, 'activity'],
  [/^\w+ \/api\/keys(\/|$)/, 'keys'],
  [/^\w+ \/api\/apps(\/|$)/, 'apps'],
  [/^\w+ \/api\/calendar$/, 'calendar'],
  [/^(POST|DELETE) \/api\/mail(\/connect)?$/, 'mail'],
  [/^\w+ \/api\/oauth\/requests\//, 'consent'],
  [/^GET \/api\/admin\/stats$/, 'stats'],
];

/** Feature label of a console API request; null = not counted. */
export function consoleFeature(method: string, path: string): string | null {
  const line = `${method.toUpperCase()} ${path}`;
  return FEATURES.find(([re]) => re.test(line))?.[1] ?? null;
}

/** After the route ran: counts it when a session was found (requireSession set `user`) and it is not background. */
export function countConsoleUsage(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const user = c.get('user') as UserRow | undefined;
    const feature = consoleFeature(c.req.method, c.req.path);
    if (!user || !feature || isBackgroundRequest(c.req.raw)) return;
    const now = Date.now();
    deferOn(c, storeOf(c.env).recordWebRequest({ userId: user.id, createdAt: user.createdAt, feature, now }));
  };
}
