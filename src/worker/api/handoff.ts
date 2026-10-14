/**
 * Token hand-off (contract §11): the bookmarklet / browser extension posts the Moodle launch payload here, gets a
 * 120 s single-use code and opens the console with `?code=`. The launch token never appears in a URL.
 */

import { Hono } from 'hono';
import { type MasterKey, randomId, sha256Hex } from '../../core/crypto';
import { Forbidden, InvalidInput } from '../../core/errors';
import { MOODLE_URL, parseLaunch } from '../../core/moodle/launch';
import type { ConnectVia } from '../../core/types';
import { type AppEnv, clientIp, rateLimit } from '../auth';
import { getRuntime } from '../context';
import type { D1Store } from '../store-d1';
import { HANDOFF_PATH, oneOf, optString, readJson, reqString, storeOf } from './shared';

const HOUR_MS = 3_600_000;
const HANDOFF_TTL_MS = 120_000;
const HANDOFF_VIAS: readonly ConnectVia[] = ['bookmarklet', 'extension'];
const MOODLE_ORIGIN = new URL(MOODLE_URL).origin;

interface HandoffPayload {
  launch: string;
  via: ConnectVia;
  passport?: string;
}

function originAllowed(origin: string): boolean {
  return origin === MOODLE_ORIGIN || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
}

const EXPIRED = 'This sign-in link has expired. Start the connection again.';

/** Reads a hand-off payload without using the code up (the caller consumes it once the sign-in is accepted). */
export async function peekHandoff(deps: { store: D1Store; key: MasterKey }, code: string): Promise<HandoffPayload> {
  const enc = await deps.store.peekHandoff(await sha256Hex(code), Date.now());
  if (!enc) throw new InvalidInput(EXPIRED);
  return JSON.parse(await deps.key.decrypt(enc)) as HandoffPayload;
}

/** Single use: exactly one caller wins. Unknown, used and expired codes look the same. */
export async function consumeHandoff(deps: { store: D1Store }, code: string): Promise<void> {
  if (!(await deps.store.takeHandoff(await sha256Hex(code), Date.now()))) throw new InvalidInput(EXPIRED);
}

export function handoffRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Credential-less CORS for Moodle pages (bookmarklet) and browser extensions only.
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
    const launch = reqString(body.launch, 'launch', 4096);
    const via = oneOf(body.via, HANDOFF_VIAS, 'via must be bookmarklet or extension.');
    const passport = optString(body.passport, 'passport', 64);
    parseLaunch(launch, passport); // format check only: no Moodle call, nothing is trusted yet

    const rt = await getRuntime(c.env);
    const code = randomId('hnd', 24);
    const now = Date.now();
    const payload: HandoffPayload = { launch, via, passport };
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
