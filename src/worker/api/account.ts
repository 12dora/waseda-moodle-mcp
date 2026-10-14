/** Sign-in, session and account routes. */

import { type Context, Hono } from 'hono';
import type { UserRow } from '../../core/context';
import { type MasterKey, sha256Hex } from '../../core/crypto';
import { InvalidInput } from '../../core/errors';
import { launchUrl, MOODLE_URL, parseLaunch } from '../../core/moodle/launch';
import { connectFromLaunch, refreshFromLaunch, toCredentialInfo, toUserInfo } from '../../core/services/account';
import { setMyCourses } from '../../core/services/scope';
import type { ConnectVia, UserSettings } from '../../core/types';
import {
  type AppEnv,
  clearSessionCookieHeader,
  clientIp,
  deferOn,
  rateLimit,
  readSessionCookie,
  registrationPolicy,
  startSession,
} from '../auth';
import { connectDeps, getRuntime } from '../context';
import { publicUrlOf, registrationMode, VERSION } from '../env';
import { normalizeSettings } from '../store/rows';
import type { D1Store } from '../store-d1';
import { consumeHandoff, peekHandoff } from './handoff';
import {
  auditConsole,
  consoleContext,
  EXTENSION_REFRESH_PATH,
  oneOf,
  optionalSessionUser,
  optString,
  readJson,
  reqString,
  session,
  storeOf,
} from './shared';

const HOUR_MS = 3_600_000;
const MAX_MY_COURSES = 60;
const MAX_COURSE_ID = 2_147_483_647;
const WRITE_MODES: readonly UserSettings['writeMode'][] = ['off', 'chat', 'console'];
const UI_LANGS: readonly UserSettings['uiLang'][] = ['auto', 'ja', 'en', 'zh-CN'];

const EXTENSION_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/** writeMode / uiLang only: the course scope goes through setMyCourses so enrolment is validated. */
function applySettingsPatch(current: UserSettings, body: Record<string, unknown>): UserSettings {
  const next: UserSettings = { ...current };
  if (body.writeMode !== undefined) {
    next.writeMode = oneOf(body.writeMode, WRITE_MODES, 'writeMode must be off, chat or console.');
  }
  if (body.uiLang !== undefined) next.uiLang = oneOf(body.uiLang, UI_LANGS, 'uiLang must be auto, ja, en or zh-CN.');
  return normalizeSettings(next);
}

/** `null` = back to the automatic suggestion; otherwise at most MAX_MY_COURSES distinct positive ids. */
function parseMyCourseIds(value: unknown): number[] | null {
  if (value === null) return null;
  if (Array.isArray(value) && value.length === 0) {
    throw new InvalidInput('Select at least one course, or reset to the suggestion.');
  }
  const valid =
    Array.isArray(value) &&
    value.length <= MAX_MY_COURSES &&
    value.every((n) => Number.isInteger(n) && n > 0 && n <= MAX_COURSE_ID);
  if (!valid) throw new InvalidInput(`myCourseIds must be null or a list of at most ${MAX_MY_COURSES} course ids.`);
  return [...new Set(value as number[])];
}

/** Applies a settings patch. The course scope goes first: it can fail (not enrolled) and must not leave half applied. */
async function patchSettings(c: Context<AppEnv>, user: UserRow, body: Record<string, unknown>): Promise<UserSettings> {
  if (body.hiddenCourseIds !== undefined) throw new InvalidInput('hiddenCourseIds is retired: use myCourseIds.');
  const ids = body.myCourseIds === undefined ? undefined : parseMyCourseIds(body.myCourseIds);
  const current = ids === undefined ? user.settings : await setMyCourses(await consoleContext(c, user), ids);
  const settings = applySettingsPatch(current, body);
  if (body.writeMode !== undefined || body.uiLang !== undefined) {
    await storeOf(c.env).updateSettings(user.id, settings);
    auditConsole(c, user, 'settings:update', { fields: ['writeMode', 'uiLang'].filter((k) => k in body) });
  }
  return settings;
}

interface ConnectRequest {
  input: { launch: string; via: ConnectVia; passport?: string };
  /** Present for hand-offs: consumed once the sign-in is accepted. */
  code?: string;
}

/** `{ code }` reads a hand-off (bookmarklet / extension); otherwise `{ launch }` is a pasted link. */
async function connectRequest(
  body: Record<string, unknown>,
  rt: { store: D1Store; key: MasterKey },
): Promise<ConnectRequest> {
  if (body.code !== undefined) {
    const code = reqString(body.code, 'code', 200);
    return { input: await peekHandoff(rt, code), code };
  }
  oneOf(body.via ?? 'paste', ['paste'], 'via must be paste when sending a launch link.');
  return {
    input: {
      launch: reqString(body.launch, 'launch', 4096),
      via: 'paste',
      passport: optString(body.passport, 'passport', 64),
    },
  };
}

export function accountRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/config', (c) => {
    const publicUrl = publicUrlOf(c.env);
    return c.json({
      publicUrl,
      mcpUrl: `${publicUrl}/mcp`,
      moodleUrl: MOODLE_URL,
      launchUrl: launchUrl('wmm', true),
      registration: registrationMode(c.env),
      extensionUrl: c.env.EXTENSION_URL?.trim() || null,
      version: VERSION,
    });
  });

  app.post('/api/connect', async (c) => {
    const rt = await getRuntime(c.env);
    await rateLimit(rt.store, { key: `connect:ip:${clientIp(c.req.raw)}`, limit: 60, windowMs: 10 * 60_000 });
    const body = await readJson(c);
    const request = await connectRequest(body, rt);
    const result = await connectFromLaunch(connectDeps(rt, registrationPolicy(c.env)), request.input);

    // A hand-off link must not silently replace the account that is signed in (login CSRF): ask first.
    if (request.code) {
      const current = await optionalSessionUser(c);
      if (current && current.id !== result.user.id && body.switchAccount !== true) {
        const message = 'This sign-in link belongs to a different account. Confirm to switch.';
        return c.json({ error: { code: 'account_switch', message }, account: { fullname: result.user.fullname } }, 409);
      }
      await consumeHandoff(rt, request.code);
    }

    const { setCookie } = await startSession(rt.store, result.user.id, c.req.header('User-Agent') ?? null);
    const old = readSessionCookie(c.req.raw);
    if (old)
      deferOn(
        c,
        sha256Hex(old).then((h) => rt.store.deleteSession(h)),
      );

    const cred = await rt.store.getCredential(result.user.id);
    c.header('Set-Cookie', setCookie);
    return c.json({
      user: toUserInfo(result.user),
      credential: cred ? toCredentialInfo(cred) : null,
      created: result.created,
    });
  });

  // Browser extension: silent token refresh. No cookie, any origin; protected by the token itself + a rate limit.
  app.use(EXTENSION_REFRESH_PATH, async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(EXTENSION_CORS)) c.res.headers.set(k, v);
  });
  app.options(EXTENSION_REFRESH_PATH, (c) => c.body(null, 204));
  app.post(EXTENSION_REFRESH_PATH, async (c) => {
    const store = storeOf(c.env);
    await rateLimit(store, { key: `ext:ip:${clientIp(c.req.raw)}`, limit: 300, windowMs: HOUR_MS });
    const body = await readJson(c);
    const launch = reqString(body.launch, 'launch', 4096);
    // per token: a stolen or looping client cannot hammer Moodle through one credential
    const tokenKey = await sha256Hex(parseLaunch(launch).token);
    await rateLimit(store, { key: `ext:token:${tokenKey}`, limit: 6, windowMs: HOUR_MS });
    const rt = await getRuntime(c.env);
    const r = await refreshFromLaunch(connectDeps(rt, registrationPolicy(c.env)), { launch });
    return c.json({ status: r.tokenChanged ? 'updated' : 'unchanged' });
  });

  app.post('/api/logout', async (c) => {
    const cookie = readSessionCookie(c.req.raw);
    if (cookie) await storeOf(c.env).deleteSession(await sha256Hex(cookie));
    c.header('Set-Cookie', clearSessionCookieHeader());
    return c.json({ ok: true });
  });

  // `credential` is null only for an account without a stored token (never after a successful connect).
  app.get('/api/me', session, async (c) => {
    const user = c.get('user');
    const cred = await storeOf(c.env).getCredential(user.id);
    return c.json({ user: toUserInfo(user), credential: cred ? toCredentialInfo(cred) : null });
  });

  app.delete('/api/me', session, async (c) => {
    const user = c.get('user');
    const oauth = c.env.OAUTH_PROVIDER;
    const grantUser = String(user.id);
    // revoking shrinks the list, so always re-list from the start (bounded)
    for (let round = 0; round < 10; round++) {
      const page = await oauth.listUserGrants(grantUser, { limit: 100 });
      if (page.items.length === 0) break;
      for (const g of page.items) await oauth.revokeGrant(g.id, grantUser);
    }
    await storeOf(c.env).deleteUser(user.id);
    c.header('Set-Cookie', clearSessionCookieHeader());
    return c.json({ ok: true });
  });

  app.patch('/api/settings', session, async (c) => {
    const user = c.get('user');
    return c.json({ settings: await patchSettings(c, user, await readJson(c)) });
  });

  return app;
}
