/** Builds the per-request ServiceContext (and Moodle clients for the file routes) from Worker bindings. */

import type { MoodleApi, ServiceContext, Signer, UserRow } from '../core/context';
import { createSigner, importMasterKey, type MasterKey } from '../core/crypto';
import { NeedsReconnect, NotFound } from '../core/errors';
import { MoodleClient } from '../core/moodle/client';
import { type Env, type McpProps, publicUrlOf } from './env';
import { createD1Store, type D1Store } from './store-d1';

/** lastOkAt is written at most this often per credential. */
export const LAST_OK_INTERVAL_MS = 10 * 60_000;

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

/**
 * Moodle client for a stored credential. Marks the credential invalid when Moodle rejects the token and refreshes
 * `lastOkAt` lazily (at most once per LAST_OK_INTERVAL_MS) after the first successful call.
 */
async function createMoodleClient(rt: Runtime, user: UserRow, defer: Defer, maxCalls?: number): Promise<MoodleApi> {
  const cred = await rt.store.getCredential(user.id);
  if (!cred) throw new NeedsReconnect('Moodle is not connected for this account. Reconnect in the console.');
  if (cred.status === 'invalid') throw new NeedsReconnect();
  const token = await rt.key.decrypt(cred.tokenEnc);
  const lastOk = cred.lastOkAt ?? 0;
  return new MoodleClient({
    token,
    moodleUserId: user.moodleUserId,
    maxCalls,
    onTokenInvalid: async () => {
      try {
        await rt.store.updateCredentialStatus(user.id, {
          status: 'invalid',
          lastError: 'Moodle rejected the stored token. Reconnect to continue.',
        });
      } catch {
        // the NeedsReconnect that follows still reaches the caller
      }
    },
    onSuccess: () => {
      const now = Date.now();
      if (now - lastOk < LAST_OK_INTERVAL_MS) return;
      defer(rt.store.updateCredentialStatus(user.id, { lastOkAt: now, lastError: null }));
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

interface BuildContextOptions {
  /** Already loaded user row (console sessions load it with the session). */
  user?: UserRow;
  /** Moodle call budget of this context's client (default: the client's own limit). */
  maxCalls?: number;
  /** false for background work (scheduled sweep): it must not count as the user being active. Default true. */
  touchUser?: boolean;
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

  let moodle: Promise<MoodleApi> | null = null;
  return {
    user,
    store: rt.store,
    signer: rt.signer,
    moodle: () => {
      // one budgeted client per request; a rejected promise is kept so NeedsReconnect is not retried
      moodle ??= createMoodleClient(rt, user, defer, opts.maxCalls);
      return moodle;
    },
    publicUrl: publicUrlOf(env),
    mode: 'worker',
    scopes: props.scopes,
    source: props.source,
    syllabusLookup: env.SYLLABUS_LOOKUP !== 'off',
    defer,
  };
}

/** Console-originated calls act with the user's full authority. */
export function consoleProps(user: UserRow): McpProps {
  return { userId: user.id, scopes: ['moodle:read', 'moodle:write'], source: 'Console' };
}

// ------------------------------------------------------------------ connect wiring

export function connectDeps(rt: Runtime, allowRegistration: (moodleUserId: number) => boolean) {
  return {
    store: rt.store,
    key: rt.key,
    makeClient: (token: string, moodleUserId: number): MoodleApi => new MoodleClient({ token, moodleUserId }),
    allowRegistration,
  };
}
