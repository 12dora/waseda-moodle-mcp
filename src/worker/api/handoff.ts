/**
 * Sign-in hand-off (contract §11): the browser extension posts the Moodle session (and / or a launch link) here, gets a
 * 120 s single-use code and opens the console with `?code=`. Neither the session nor a token ever appears in a URL.
 */

import { Hono } from 'hono';
import { type MasterKey, randomId, sha256Hex } from '../../core/crypto';
import { Forbidden, InvalidInput } from '../../core/errors';
import { parseLaunch } from '../../core/moodle/launch';
import { normalizeSessionCookie } from '../../core/moodle/web/identify';
import type { SignInInput } from '../../core/services/account';
import type { SignInVia } from '../../core/types';
import { type AppEnv, clientIp, rateLimit } from '../auth';
import { getRuntime } from '../context';
import type { D1Store } from '../store-d1';
import { HANDOFF_PATH, oneOf, readJson, signInFields, storeOf } from './shared';

const HOUR_MS = 3_600_000;
const HANDOFF_TTL_MS = 120_000;
const HANDOFF_VIAS: readonly SignInVia[] = ['extension'];

function originAllowed(origin: string): boolean {
  return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
}

const EXPIRED = 'This sign-in link has expired. Start the connection again.';

/** Reads a hand-off payload without using the code up (the caller consumes it once the sign-in is accepted). */
export async function peekHandoff(deps: { store: D1Store; key: MasterKey }, code: string): Promise<SignInInput> {
  const enc = await deps.store.peekHandoff(await sha256Hex(code), Date.now());
  if (!enc) throw new InvalidInput(EXPIRED);
  return JSON.parse(await deps.key.decrypt(enc)) as SignInInput;
}

/** Single use: exactly one caller wins. Unknown, used and expired codes look the same. */
export async function consumeHandoff(deps: { store: D1Store }, code: string): Promise<void> {
  if (!(await deps.store.takeHandoff(await sha256Hex(code), Date.now()))) throw new InvalidInput(EXPIRED);
}

export function handoffRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Credential-less CORS for browser extensions only.
  app.use(HANDOFF_PATH, async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin !== undefined && !originAllowed(origin)) throw new Forbidden('Origin not allowed.');
    await next();
    if (origin === undefined) return;
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    c.res.headers.set('Access-Control-Max-Age', '86400');
    c.res.headers.append('Vary', 'Origin');
  });
  app.options(HANDOFF_PATH, (c) => c.body(null, 204));

  app.post(HANDOFF_PATH, async (c) => {
    await rateLimit(storeOf(c.env), { key: `hnd:ip:${clientIp(c.req.raw)}`, limit: 60, windowMs: HOUR_MS });
    const body = await readJson(c);
    const fields = signInFields(body);
    const via = oneOf(body.via, HANDOFF_VIAS, 'via must be extension.');
    // format checks only: no Moodle call, nothing is trusted yet
    if (fields.session) normalizeSessionCookie(fields.session);
    if (fields.launch) parseLaunch(fields.launch, fields.passport);

    const rt = await getRuntime(c.env);
    const code = randomId('hnd', 24);
    const now = Date.now();
    const payload: SignInInput = { ...fields, via };
    await rt.store.putHandoff({
      codeHash: await sha256Hex(code),
      payloadEnc: await rt.key.encrypt(JSON.stringify(payload)),
      createdAt: now,
      expiresAt: now + HANDOFF_TTL_MS,
    });
    return c.json({ code });
  });

  return app;
}
