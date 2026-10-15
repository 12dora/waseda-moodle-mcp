/**
 * Console REST API (contract §5, §11), the OAuth `/authorize` entry, `/health` and the file ticket routes.
 * This Hono app is the OAuth provider's `defaultHandler`: everything that is not /mcp, /token, /register or
 * /.well-known/* ends up here.
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { WmmError } from '../../core/errors';
import { type AppEnv, csrfGuard } from '../auth';
import { calendarRoutes } from '../calendar/routes';
import { filesRoutes } from '../files-routes';
import { errorPayload } from '../http-errors';
import { landingRoutes } from '../landing';
import { accountRoutes } from './account';
import { coursesViewRoutes } from './courses-view';
import { dataRoutes } from './data';
import { handoffRoutes } from './handoff';
import { keyRoutes } from './keys';
import { oauthRoutes } from './oauth';
import { CSRF_EXEMPT_PATHS } from './shared';

export function createApi(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const csrf = csrfGuard();

  app.onError((err, c) => {
    if (!(err instanceof WmmError)) {
      console.error('api error:', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown');
    }
    const { status, body } = errorPayload(err);
    return c.json(body, status);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404));

  app.get('/health', (c) => c.json({ ok: true }));

  // Console and consent pages must never be framed (clickjacking); API answers are private.
  const noFraming: MiddlewareHandler<AppEnv> = async (c, next) => {
    await next();
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  };
  app.use('/authorize', noFraming);
  app.use('/api/*', noFraming);
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/api/*', (c, next) => (CSRF_EXEMPT_PATHS.has(c.req.path) ? next() : csrf(c, next)));

  app.route('/', accountRoutes());
  app.route('/', handoffRoutes());
  app.route('/', keyRoutes());
  app.route('/', dataRoutes());
  app.route('/', coursesViewRoutes());
  app.route('/', calendarRoutes());
  app.route('/', landingRoutes());
  app.route('/', oauthRoutes());
  // signed file tickets (no cookies, CORS *)
  app.route('/', filesRoutes());

  return app;
}
