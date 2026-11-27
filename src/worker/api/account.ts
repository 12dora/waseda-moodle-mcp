/** Sign-in, session and account routes. */

import { type Context, Hono } from 'hono';
import type { UserRow } from '../../core/context';
import { type MasterKey, sha256Hex } from '../../core/crypto';
import { InvalidInput } from '../../core/errors';
import { launchUrl, MOODLE_URL, parseLaunch } from '../../core/moodle/launch';
import { normalizeSessionCookie } from '../../core/moodle/web/identify';
import {
  connectAccount,
  refreshFromLaunch,
  refreshFromSession,
  type SignInInput,
  toCredentialInfo,
  toUserInfo,
} from '../../core/services/account';
import { applyScheduleOverrides, validateScheduleOverrides } from '../../core/services/schedule-overrides';
import { setMyCourses } from '../../core/services/scope';
import type { CredentialInfo, SignInVia, UserSettings } from '../../core/types';
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
import { connectDeps, getRuntime, startRenewal } from '../context';
import { adminMoodleUserIds, publicUrlOf, registrationMode, VERSION } from '../env';
import { mobileServiceOn } from '../site-flag';
import { normalizeSettings } from '../store/rows';
import type { D1Store } from '../store-d1';
import { consumeHandoff, peekHandoff } from './handoff';
import { mailInfo, revokeStoredMail } from './mail';
import {
  auditConsole,
  consoleContext,
  EXTENSION_REFRESH_PATH,
  oneOf,
  optionalSessionUser,
  readJson,
  reqString,
  session,
  signInFields,
  storeOf,
} from './shared';

const HOUR_MS = 3_600_000;
const MAX_MY_COURSES = 60;
const MAX_COURSE_ID = 2_147_483_647;
const WRITE_MODES: readonly UserSettings['writeMode'][] = ['off', 'chat', 'console'];
const UI_LANGS: readonly UserSettings['uiLang'][] = ['auto', 'ja', 'en', 'zh-CN'];
/** Who may say a session came from them; a pasted launch link is always 'paste'. */
const SESSION_VIAS: readonly SignInVia[] = ['paste', 'extension'];
const LAUNCH_VIAS: readonly SignInVia[] = ['paste'];

const EXTENSION_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/** writeMode / uiLang only: the course scope goes through setMyCourses, the schedules through their own service. */
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

/**
 * The course scope and the schedule overrides go first: both can fail (bad input, not enrolled), so everything is
 * validated before the first write and a failure leaves nothing half applied.
 */
async function applyCourseSettings(
  c: Context<AppEnv>,
  user: UserRow,
  body: Record<string, unknown>,
): Promise<UserSettings> {
  const ids = body.myCourseIds === undefined ? undefined : parseMyCourseIds(body.myCourseIds);
  if (ids === undefined && body.scheduleOverrides === undefined) return user.settings;
  const ctx = await consoleContext(c, user);
  const changes =
    body.scheduleOverrides === undefined ? undefined : await validateScheduleOverrides(ctx, body.scheduleOverrides);
  const scope = ids === undefined ? user.settings : await setMyCourses(ctx, ids);
  if (changes === undefined) return scope;
  return { ...scope, scheduleOverrides: await applyScheduleOverrides(ctx, changes) };
}

/** Applies a settings patch. */
async function patchSettings(c: Context<AppEnv>, user: UserRow, body: Record<string, unknown>): Promise<UserSettings> {
  if (body.hiddenCourseIds !== undefined) throw new InvalidInput('hiddenCourseIds is retired: use myCourseIds.');
  applySettingsPatch(user.settings, body); // rejects a bad writeMode / uiLang before anything is written
  const settings = applySettingsPatch(await applyCourseSettings(c, user, body), body);
  // the course scope and the schedules shape every cached console read (console-cache.ts): compute them again
  if (body.myCourseIds !== undefined || body.scheduleOverrides !== undefined) {
    await storeOf(c.env).clearConsoleCache(user.id);
  }
  if (body.writeMode !== undefined || body.uiLang !== undefined) {
    await storeOf(c.env).updateSettings(user.id, settings);
    auditConsole(c, user, 'settings:update', { fields: ['writeMode', 'uiLang'].filter((k) => k in body) });
  }
  return settings;
}

interface ConnectRequest {
  input: SignInInput;
  /** Present for hand-offs: consumed once the sign-in is accepted. */
  code?: string;
}

/** `{ code }` reads a hand-off (browser extension); otherwise `{ session }` or `{ launch }` is sent directly. */
async function connectRequest(
  body: Record<string, unknown>,
  rt: { store: D1Store; key: MasterKey },
): Promise<ConnectRequest> {
  if (body.code !== undefined) {
    const code = reqString(body.code, 'code', 200);
    return { input: await peekHandoff(rt, code), code };
  }
  const fields = signInFields(body);
  const via = fields.session
    ? oneOf(body.via ?? 'paste', SESSION_VIAS, 'via must be paste or extension when sending a session.')
    : oneOf(body.via ?? 'paste', LAUNCH_VIAS, 'via must be paste when sending a launch link.');
  return { input: { ...fields, via } };
}

/** The stored credential as the console shows it; null for an account without one. */
async function credentialInfo(store: D1Store, userId: number): Promise<CredentialInfo | null> {
  const cred = await store.getCredential(userId);
  return cred ? toCredentialInfo(cred, await mobileServiceOn(store)) : null;
}

/** Signs in from a Moodle session, a pasted launch link or a hand-off code and starts a console session. */
async function connect(c: Context<AppEnv>): Promise<Response> {
  const rt = await getRuntime(c.env);
  await rateLimit(rt.store, { key: `connect:ip:${clientIp(c.req.raw)}`, limit: 60, windowMs: 10 * 60_000 });
  const body = await readJson(c);
  const request = await connectRequest(body, rt);
  const result = await connectAccount(connectDeps(rt, registrationPolicy(c.env)), request.input);

  // A sign-in must not silently replace the account that is signed in here (login CSRF for hand-off links, a
  // pasted cookie of another Moodle account): ask first.
  const current = await optionalSessionUser(c);
  if (current && current.id !== result.user.id && body.switchAccount !== true) {
    const message = 'This Moodle sign-in belongs to another account than the one signed in here. Confirm to switch.';
    return c.json({ error: { code: 'account_switch', message }, account: { fullname: result.user.fullname } }, 409);
  }
  if (request.code) await consumeHandoff(rt, request.code);
  // a reconnect may be another Moodle session (or a renamed enrolment): the console's copies are read again
  await rt.store.clearConsoleCache(result.user.id);

  const { setCookie } = await startSession(rt.store, result.user.id, c.req.header('User-Agent') ?? null);
  const old = readSessionCookie(c.req.raw);
  if (old)
    deferOn(
      c,
      sha256Hex(old).then((h) => rt.store.deleteSession(h)),
    );

  deferOn(
    c,
    rt.store.getCredential(result.user.id).then((cred) => startRenewal(rt, result.user, cred)),
  );
  deferOn(c, rt.store.recordCounts(Date.now(), [{ metric: 'connect', dim: request.input.via }]));
  c.header('Set-Cookie', setCookie);
  return c.json({
    user: toUserInfo(result.user),
    credential: await credentialInfo(rt.store, result.user.id),
    created: result.created,
  });
}

/**
 * Browser extension: silently stores the browser's current Moodle session (or refreshes the token from a launch link)
 * for an existing account. Limited per IP, per launch token, and per account when a session is sent.
 */
async function extensionRefresh(c: Context<AppEnv>): Promise<Response> {
  const store = storeOf(c.env);
  await rateLimit(store, { key: `ext:ip:${clientIp(c.req.raw)}`, limit: 300, windowMs: HOUR_MS });
  const { session: moodleSession, launch, passport } = signInFields(await readJson(c));
  // per credential before Moodle is asked, per account after: a stolen or looping client cannot hammer Moodle
  // through one credential, nor through rotating cookies of one account
  const limit = (key: string) => rateLimit(store, { key, limit: 6, windowMs: HOUR_MS });
  if (moodleSession) await limit(`ext:session:${await sha256Hex(normalizeSessionCookie(moodleSession))}`);
  else if (launch) await limit(`ext:token:${await sha256Hex(parseLaunch(launch).token)}`);
  const rt = await getRuntime(c.env);
  const deps = connectDeps(rt, registrationPolicy(c.env));
  const r = moodleSession
    ? await refreshFromSession(deps, {
        session: moodleSession,
        launch,
        passport,
        admit: (user) => limit(`ext:user:${user.id}`),
      })
    : await refreshFromLaunch(deps, { launch: reqString(launch, 'launch', 4096) });
  deferOn(
    c,
    rt.store.getCredential(r.user.id).then((cred) => startRenewal(rt, r.user, cred)),
  );
  return c.json({ status: r.changed ? 'updated' : 'unchanged' });
}

/** Revokes the account's OAuth grants and its Google mail token, then deletes the account and everything it owns. */
async function deleteAccount(c: Context<AppEnv>): Promise<Response> {
  const user = c.get('user');
  const oauth = c.env.OAUTH_PROVIDER;
  const grantUser = String(user.id);
  // revoking shrinks the list, so always re-list from the start (bounded)
  for (let round = 0; round < 10; round++) {
    const page = await oauth.listUserGrants(grantUser, { limit: 100 });
    if (page.items.length === 0) break;
    for (const g of page.items) await oauth.revokeGrant(g.id, grantUser);
  }
  await revokeStoredMail(c.env, user.id); // best effort, never throws: the row goes with the account
  await storeOf(c.env).deleteUser(user.id);
  c.header('Set-Cookie', clearSessionCookieHeader());
  return c.json({ ok: true });
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

  app.post('/api/connect', connect);

  // Browser extension: silent refresh. No cookie, any origin; protected by the sign-in it carries + a rate limit.
  app.use(EXTENSION_REFRESH_PATH, async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(EXTENSION_CORS)) c.res.headers.set(k, v);
  });
  app.options(EXTENSION_REFRESH_PATH, (c) => c.body(null, 204));
  app.post(EXTENSION_REFRESH_PATH, extensionRefresh);

  app.post('/api/logout', async (c) => {
    const cookie = readSessionCookie(c.req.raw);
    if (cookie) await storeOf(c.env).deleteSession(await sha256Hex(cookie));
    c.header('Set-Cookie', clearSessionCookieHeader());
    return c.json({ ok: true });
  });

  // `credential` is null only for an account without a stored one (never after a successful connect).
  app.get('/api/me', session, async (c) => {
    const user = c.get('user');
    const store = storeOf(c.env);
    const [credential, mail] = await Promise.all([credentialInfo(store, user.id), mailInfo(c.env, store, user)]);
    return c.json({
      user: toUserInfo(user),
      credential,
      isAdmin: adminMoodleUserIds(c.env).has(user.moodleUserId),
      mail,
    });
  });

  app.delete('/api/me', session, deleteAccount);

  app.patch('/api/settings', session, async (c) => {
    const user = c.get('user');
    return c.json({ settings: await patchSettings(c, user, await readJson(c)) });
  });

  return app;
}
