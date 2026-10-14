/** Thin HTTP adapters for signed file tickets: GET /f/:ticket (download) and PUT|POST /u/:ticket (upload). */

import { type Context, Hono } from 'hono';
import { WmmError } from '../core/errors';
import { type FileRouteEnv, streamDownload, streamUpload } from '../core/services/files';
import { getRuntime, makeMoodleFactory, tryExecutionContext, type WaitUntil } from './context';
import type { Env } from './env';

const FILE_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Content-Length, Range, X-WMM',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition, Accept-Ranges',
  'Access-Control-Max-Age': '86400',
};

/** Copies the response (headers of upstream responses may be immutable) and adds CORS; the body is never read. */
function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(FILE_CORS)) out.headers.set(k, v);
  return out;
}

function errorResponse(e: unknown): Response {
  const status = e instanceof WmmError && e.code === 'invalid_input' ? 400 : 500;
  const body = {
    error: {
      code: e instanceof WmmError ? e.code : 'internal',
      message: e instanceof WmmError ? e.message : 'Internal error.',
    },
  };
  return withCors(Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } }));
}

export function filesRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  const preflight = () => new Response(null, { status: 204, headers: FILE_CORS });
  app.options('/f/:ticket', preflight);
  app.options('/u/:ticket', preflight);

  async function fileEnv(env: Env, execCtx: WaitUntil | undefined): Promise<FileRouteEnv> {
    const rt = await getRuntime(env);
    return { store: rt.store, signer: rt.signer, makeMoodle: makeMoodleFactory(env, execCtx) };
  }

  const execOf = tryExecutionContext;

  app.get('/f/:ticket', async (c) => {
    try {
      const res = await streamDownload(await fileEnv(c.env, execOf(c)), c.req.param('ticket'), c.req.raw);
      return withCors(res);
    } catch (e) {
      return errorResponse(e);
    }
  });

  const upload = async (c: Context<{ Bindings: Env }>) => {
    try {
      const res = await streamUpload(await fileEnv(c.env, execOf(c)), c.req.param('ticket') ?? '', c.req.raw);
      return withCors(res);
    } catch (e) {
      return errorResponse(e);
    }
  };
  app.put('/u/:ticket', upload);
  app.post('/u/:ticket', upload);

  return app;
}
