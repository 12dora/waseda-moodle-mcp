/** Builds the per-request ServiceContext (and Moodle clients for the file routes) from Worker bindings. */

import type { InvocationBudget } from '../core/budget';
import type {
  CredentialRow,
  MailApi,
  MailCredentialRow,
  MoodleApi,
  ServiceContext,
  Signer,
  UsageRecorder,
  UserRow,
} from '../core/context';
import { createSigner, importMasterKey, type MasterKey } from '../core/crypto';
import { MoodleBusy, NeedsReconnect, NotFound } from '../core/errors';
import { GmailClient } from '../core/mail/client';
import { mailReconnect } from '../core/mail/connection';
import { MoodleClient } from '../core/moodle/client';
import { createChannelClient } from '../core/moodle/web/channel';
import { isUsable } from '../core/services/account';
import {
  type RenewalDeps,
  type RenewalOutcome,
  refreshCredential,
  rejectToken,
  StoredSession,
} from '../core/services/credential-renewal';
import { clientLabel, renewalCounts } from '../core/usage';
import { type Env, googleClientOf, type McpProps, publicUrlOf } from './env';
import { mobileServiceOn, setMobileService } from './site-flag';
import { createD1Store, type D1Store } from './store-d1';

/** lastOkAt / sessionOkAt (Moodle) and lastUsedAt (mail) are written at most this often per credential. */
export const LAST_OK_INTERVAL_MS = 10 * 60_000;
/** sessionUsedAt (a console / MCP request used the web session) is written at most this often; the sweep reads it. */
export const SESSION_USE_STAMP_MS = 60_000;

interface Runtime {
  store: D1Store;
  key: MasterKey;
  signer: Signer;
}

type Defer = (p: Promise<unknown>) => void;
/** Minimal structural view of an execution context (Hono's and workerd's types differ in the rest). */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

const runtimes = new WeakMap<object, Promise<Runtime>>();

/** Store + master key + signer, built once per isolate (the HKDF/AES key import is the only non-trivial cost). */
export function getRuntime(env: Env): Promise<Runtime> {
  let rt = runtimes.get(env);
  if (!rt) {
    rt = importMasterKey(env.MASTER_KEY).then((key) => ({
      store: createD1Store(env.DB),
      key,
      signer: createSigner(key),
    }));
    // a bad MASTER_KEY must not stay cached as a rejected promise forever
    rt.catch(() => runtimes.delete(env));
    runtimes.set(env, rt);
  }
  return rt;
}

/** Hono's `c.executionCtx` throws when there is none (unit tests); this returns undefined instead. */
export function tryExecutionContext(c: { readonly executionCtx: WaitUntil }): WaitUntil | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

export function makeDefer(execCtx: WaitUntil | undefined): Defer {
  return (p) => {
    const guarded = p.catch(() => undefined);
    if (execCtx) execCtx.waitUntil(guarded);
  };
}

export const renewalDeps = (rt: Runtime): RenewalDeps => ({ store: rt.store, key: rt.key });

/** Credential-health counters of one refresh or ended session (operator statistics; never activity). Never throws. */
async function countRenewal(store: D1Store, outcome: Pick<RenewalOutcome, 'status' | 'reason'>): Promise<void> {
  const counts = renewalCounts(outcome);
  if (counts.length > 0) await store.recordCounts(Date.now(), counts).catch(() => undefined);
}

interface ClientOptions {
  maxCalls?: number;
  budget?: InvocationBudget;
}

interface MoodleClientSetup extends ClientOptions {
  /** The cron's own work: it does not stamp the session's use (sessionUsedAt). */
  scheduled?: boolean;
}

type ChannelOptions = Parameters<typeof createChannelClient>[0];

/** What the two channels of one client share. */
interface Connection {
  rt: Runtime;
  user: UserRow;
  cred: CredentialRow;
  defer: Defer;
  limits: ClientOptions;
}

/** Whether a stamp is old enough to be written again. */
const isStale = (at: number | null | undefined, interval = LAST_OK_INTERVAL_MS): boolean =>
  Date.now() - (at ?? 0) >= interval;

/** Requests take the web session (moodle/web/channel: no token, or the mobile web service is off). */
const takesWebSession = (cred: CredentialRow, mobileService: boolean): boolean =>
  Boolean(cred.sessionEnc) && !(cred.tokenEnc && mobileService);

/**
 * Until when the web session counts as busy (one of its requests ran out of time, see MoodleBusy); null = it does
 * not, or requests take the token channel, which the mark does not concern.
 */
function busyUntilOf(cred: CredentialRow, mobileService: boolean, now = Date.now()): number | null {
  const until = cred.busyUntil ?? 0;
  return until > now && takesWebSession(cred, mobileService) ? until : null;
}

/** The user's web-session busy mark as the next Moodle client would see it (null = not busy). */
export async function sessionBusyUntil(store: D1Store, userId: number): Promise<number | null> {
  const cred = await store.getCredential(userId);
  return cred ? busyUntilOf(cred, await mobileServiceOn(store)) : null;
}

/**
 * The token channel. When Moodle rejects the token, a stored web session is asked for the current one first (launch.php
 * only, charged to this client, never an autologin: concurrent requests cannot open sessions). Without success the
 * rejected token is given up (rejectToken). Refreshes `lastOkAt` lazily (at most once per LAST_OK_INTERVAL_MS).
 */
async function tokenChannel(c: Connection, tokenEnc: string): Promise<NonNullable<ChannelOptions['token']>> {
  const { rt, user, cred, defer } = c;
  return {
    ...c.limits,
    token: await rt.key.decrypt(tokenEnc),
    moodleUserId: user.moodleUserId,
    renewToken: cred.sessionEnc
      ? async (fetch) => {
          const outcome = await refreshCredential({ ...renewalDeps(rt), fetch }, user, cred);
          defer(countRenewal(rt.store, outcome));
          return outcome.token ?? null;
        }
      : undefined,
    // best effort: the NeedsReconnect that follows reaches the caller either way
    onTokenInvalid: (rejected) => rejectToken(rt.store, user.id, rejected).catch(() => undefined),
    onSuccess: () => {
      if (!isStale(cred.lastOkAt)) return;
      defer(rt.store.updateCredentialStatus(user.id, { lastOkAt: Date.now(), lastError: null }));
    },
  };
}

/**
 * The web session channel: a rotated cookie or new sesskey is stored, an ended session forgotten (the credential then
 * turns invalid unless a usable token remains), and a successful call stamps `sessionOkAt` lazily, which also spares
 * the keepalive a visit. A request that ran out of time marks the session busy (busyUntil); the next success clears
 * the mark this client read (a newer one, set meanwhile, stays).
 */
async function webChannel(
  c: Connection,
  sessionEnc: string,
  mobileService: () => boolean,
): Promise<NonNullable<ChannelOptions['session']>> {
  const { rt, user, cred, defer } = c;
  const stored = new StoredSession(renewalDeps(rt), user.id, sessionEnc);
  const later = (write: Promise<unknown>): Promise<void> => {
    defer(write);
    return write.then(
      () => undefined,
      () => undefined,
    );
  };
  const ended = async () => {
    if (await stored.end(mobileService())) await countRenewal(rt.store, { status: 'ended' });
  };
  return {
    ...c.limits,
    moodleUserId: user.moodleUserId,
    session: {
      cookie: await rt.key.decrypt(sessionEnc),
      sesskey: cred.sesskeyEnc ? await rt.key.decrypt(cred.sesskeyEnc) : null,
      onUpdate: (change) => later(stored.update(change)),
      onEnded: () => later(ended()),
    },
    busyUntil: cred.busyUntil,
    onBusy: (until) => defer(rt.store.updateCredentialStatus(user.id, { busyUntil: until })),
    onSuccess: () => {
      const { busyUntil } = cred;
      if (busyUntil) defer(rt.store.updateCredentialIf(user.id, { busyUntil }, { busyUntil: null }));
      if (cred.status === 'active' && !isStale(cred.sessionOkAt)) return;
      defer(stored.confirm(Date.now()));
    },
  };
}

/**
 * Moodle client for a stored credential: the token channel while the mobile web service is on and a token exists, the
 * web session otherwise (moodle/web/channel). A credential with neither needs a reconnect. An `invalid` credential
 * with a session is still tried: the session works on its own, and it renews a rejected token. While the web session
 * is busy (busyUntilOf) no client is made: MoodleBusy at once. A request (not the cron) stamps the session's use.
 */
async function createMoodleClient(
  rt: Runtime,
  user: UserRow,
  defer: Defer,
  setup: MoodleClientSetup = {},
): Promise<MoodleApi> {
  const { scheduled, ...limits } = setup;
  const cred = await rt.store.getCredential(user.id);
  if (!cred) {
    throw new NeedsReconnect(
      'Moodle is not connected for this account. Reconnect in the console (browser extension or Moodle session cookie).',
    );
  }
  let mobileService = await mobileServiceOn(rt.store);
  if (!isUsable(cred, mobileService)) throw new NeedsReconnect();
  const busyUntil = busyUntilOf(cred, mobileService);
  if (busyUntil !== null) throw new MoodleBusy(busyUntil);
  if (!scheduled && takesWebSession(cred, mobileService) && isStale(cred.sessionUsedAt, SESSION_USE_STAMP_MS)) {
    defer(rt.store.updateCredentialStatus(user.id, { sessionUsedAt: Date.now() }));
  }
  const connection: Connection = { rt, user, cred, defer, limits };
  const { tokenEnc, sessionEnc } = cred;
  return createChannelClient({
    moodleUserId: user.moodleUserId,
    mobileService,
    token: tokenEnc ? await tokenChannel(connection, tokenEnc) : null,
    session: sessionEnc ? await webChannel(connection, sessionEnc, () => mobileService) : null,
    onMobileServiceOff: () => {
      mobileService = false;
      return setMobileService(rt.store, false);
    },
  });
}

/** For `/f/*` and `/u/*`: client by user id (ticket payloads carry the id). */
export function makeMoodleFactory(env: Env, execCtx: WaitUntil | undefined): (userId: number) => Promise<MoodleApi> {
  const defer = makeDefer(execCtx);
  return async (userId) => {
    const rt = await getRuntime(env);
    const user = await rt.store.getUser(userId);
    if (!user) throw new NotFound('Account not found.');
    return createMoodleClient(rt, user, defer);
  };
}

// ------------------------------------------------------------------ mail

type GoogleClient = NonNullable<ReturnType<typeof googleClientOf>>;

interface MailSetup extends ClientOptions {
  rt: Runtime;
  defer: Defer;
  /** The context represents the user: a successful call refreshes lastUsedAt (idle cleanup). Background work: false. */
  trackUse: boolean;
}

/**
 * Gmail client for a stored mail connection. An ended connection (invalid, or revoked by the idle cleanup) throws
 * MailNeedsReconnect with the reason; a refresh token Google rejects marks the row invalid, unless the row holds
 * another token meanwhile (a reconnect while this request was running).
 */
async function createMailClient(s: MailSetup, google: GoogleClient, row: MailCredentialRow): Promise<MailApi> {
  const refreshEnc = row.refreshEnc;
  if (row.status === 'invalid' || !refreshEnc) throw mailReconnect(row.lastError);
  const { store } = s.rt;
  const lastUsed = row.lastUsedAt ?? 0;
  return new GmailClient({
    address: row.address,
    scopes: row.scopes,
    refreshToken: await s.rt.key.decrypt(refreshEnc),
    ...google,
    maxCalls: s.maxCalls,
    budget: s.budget,
    onInvalid: () =>
      store.updateMailCredentialIf(
        row.userId,
        { refreshEnc },
        { status: 'invalid', lastError: 'Google rejected the stored mail authorization.' },
      ),
    onUsed: () => {
      const now = Date.now();
      if (!s.trackUse || now - lastUsed < LAST_OK_INTERVAL_MS) return;
      s.defer(store.updateMailCredential(row.userId, { lastUsedAt: now }));
    },
  });
}

/** ctx.mail of a user: undefined when mail is not configured or the user has no stored connection (one D1 read). */
async function mailOf(env: Env, s: MailSetup, userId: number): Promise<(() => Promise<MailApi>) | undefined> {
  const google = googleClientOf(env);
  if (!google) return undefined;
  const row = await s.rt.store.getMailCredential(userId);
  if (!row) return undefined;
  let client: Promise<MailApi> | null = null;
  return () => {
    // one budgeted client per request; a rejected promise is kept so NeedsReconnect is not retried
    client ??= createMailClient(s, google, row);
    return client;
  };
}

/** For `/f/*` (mail attachments): mail client by user id (ticket payloads carry the id). */
export function makeMailFactory(env: Env, execCtx: WaitUntil | undefined): (userId: number) => Promise<MailApi> {
  const defer = makeDefer(execCtx);
  return async (userId) => {
    const rt = await getRuntime(env);
    const user = await rt.store.getUser(userId);
    if (!user) throw new NotFound('Account not found.');
    const mail = await mailOf(env, { rt, defer, trackUse: true }, user.id);
    if (!mail) throw new NotFound('Mail is not connected.');
    return mail();
  };
}

interface BuildContextOptions {
  /** Already loaded user row (console sessions load it with the session). */
  user?: UserRow;
  /** Moodle call budget of this context's client (default: the client's own limit). */
  maxCalls?: number;
  /** The invocation's shared budget (scheduled run): the client's requests are charged to it too. */
  budget?: InvocationBudget;
  /** false for background work (sweep, console background requests): not the user being active. Default true. */
  touchUser?: boolean;
  /** true for the cron's own work (course sweep): it never stamps the web session's use. Default false. */
  scheduled?: boolean;
  /** true for `/mcp` requests: tool calls feed the operator statistics (not the console, not the sweep). Default false. */
  recordUsage?: boolean;
  /**
   * true when the context may use the Waseda mailbox (`/mcp`, the console's action approval): ctx.mail costs one D1
   * read, so every other context (sweep, calendar feed, other console routes) leaves it undefined. Default false.
   */
  mail?: boolean;
}

/** Tool calls of one MCP request, counted past the response (never throws into the tool). */
function usageRecorder(store: D1Store, user: UserRow, source: string, defer: Defer): UsageRecorder {
  const client = clientLabel(source);
  const actor = { userId: user.id, createdAt: user.createdAt };
  return {
    toolCall: (call) => defer(store.recordToolCall({ ...actor, ...call, client, now: Date.now() })),
  };
}

/** `props` come from the OAuth provider (`ctx.props`) or from the console session (source 'Console'). */
export async function buildServiceContext(
  env: Env,
  execCtx: WaitUntil | undefined,
  props: McpProps,
  opts: BuildContextOptions = {},
): Promise<ServiceContext> {
  const rt = await getRuntime(env);
  const user = opts.user ?? (await rt.store.getUser(props.userId));
  if (!user) throw new NotFound('Account not found.');
  const defer = makeDefer(execCtx);

  const now = Date.now();
  const stale = user.lastSeenAt === null || now - user.lastSeenAt > 3_600_000;
  if (stale && opts.touchUser !== false) defer(rt.store.touchUser(user.id, now));

  const clientOpts = { maxCalls: opts.maxCalls, budget: opts.budget };
  const mailSetup = { rt, defer, trackUse: opts.touchUser !== false, ...clientOpts };
  const moodleSetup = { ...clientOpts, scheduled: opts.scheduled };
  const mail = opts.mail ? await mailOf(env, mailSetup, user.id) : undefined;
  let moodle: Promise<MoodleApi> | null = null;
  return {
    user,
    store: rt.store,
    signer: rt.signer,
    moodle: () => {
      // one budgeted client per request; a rejected promise is kept so NeedsReconnect is not retried
      moodle ??= createMoodleClient(rt, user, defer, moodleSetup);
      return moodle;
    },
    mail,
    publicUrl: publicUrlOf(env),
    mode: 'worker',
    scopes: props.scopes,
    source: props.source,
    syllabusLookup: env.SYLLABUS_LOOKUP !== 'off',
    defer,
    usage: opts.recordUsage ? usageRecorder(rt.store, user, props.source, defer) : undefined,
  };
}

/** Console-originated calls act with the user's full authority. */
export function consoleProps(user: UserRow): McpProps {
  return { userId: user.id, scopes: ['moodle:read', 'moodle:write'], source: 'Console' };
}

// ------------------------------------------------------------------ connect wiring

/**
 * After a connect or refresh that stored a private token, while the mobile web service is on: opens the web session
 * right away, so renewal is active at once (a newly connected credential is tried at once; otherwise the policy's retry
 * wait applies).
 */
export async function startRenewal(rt: Runtime, user: UserRow, cred: CredentialRow | null): Promise<void> {
  if (!cred?.privateTokenEnc || cred.sessionEnc || cred.status !== 'active') return;
  if (!(await mobileServiceOn(rt.store))) return;
  await countRenewal(rt.store, await refreshCredential(renewalDeps(rt), user, cred, { autologin: true }));
}

export function connectDeps(rt: Runtime, allowRegistration: (moodleUserId: number) => boolean) {
  return {
    store: rt.store,
    key: rt.key,
    makeClient: (token: string, moodleUserId: number): MoodleApi => new MoodleClient({ token, moodleUserId }),
    allowRegistration,
    // a launch-link connect must work at once, not only after the cron has noticed the service is back
    onTokenVerified: () => setMobileService(rt.store, true),
  };
}
