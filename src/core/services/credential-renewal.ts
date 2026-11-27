/**
 * Upkeep of a stored Moodle connection.
 *
 * Web session: Moodle ends it after 4 h idle, so the hourly keepalive touches it (one `core_session_touch`).
 * App token (while the mobile web service is on, with a private token): tokens live about a week; the session asks
 * launch.php for the current one, which also keeps the session alive, and Moodle issues a new one there once the old
 * one expired. A session is opened with the private token (autologin: right after a connect, and by the keepalive when
 * launch.php finds the session ended; never inside a tool call). Protocol: moodle/web-session.
 *
 * Every write is a compare-and-set on the credential as it was read (token hash, session cookie, autologin stamp): work
 * that lost a race to another refresh, a reconnect or an invalidation never overwrites the newer state.
 */

import type { CredentialPatch, CredentialRow, Store, UserRow } from '../context';
import { sha256Hex } from '../crypto';
import { BudgetExceeded, MoodleError, MoodleUnavailable, NeedsReconnect } from '../errors';
import { MoodleWebSession } from '../moodle/web/session';
import { launchWithSession, openSession } from '../moodle/web-session';
import { nowMs } from '../time';
import { type CredentialDeps, confirmed, tokenColumns } from './account';

/** After an autologin attempt the next one waits this long, unless the credential was connected since. */
export const AUTOLOGIN_RETRY_MS = 6 * 3_600_000;
export const SESSION_ENDED = 'The Moodle session ended. Reconnect to continue.';
const TOKEN_REJECTED = 'Moodle rejected the stored token. Reconnect to continue.';

/**
 * The patch that forgets a session Moodle ended. With no usable token left (none stored, or the mobile web service is
 * off) the credential becomes invalid.
 */
function sessionEnded(cred: CredentialRow, mobileService: boolean): CredentialPatch {
  const forget = { sessionEnc: null, sesskeyEnc: null, sessionOkAt: null, sessionTriedAt: null };
  if (cred.tokenEnc && mobileService) return forget;
  return { ...forget, status: 'invalid', lastError: SESSION_ENDED };
}

/**
 * The stored web session as one invocation read it. Writes are queued (a rotated cookie is saved before what follows
 * it) and apply only while the credential still holds that session, so a newer sign-in is never touched.
 */
export class StoredSession {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: CredentialDeps,
    private readonly userId: number,
    /** The stored cookie (ciphertext) this invocation works with. */
    private enc: string,
  ) {}

  /** Moodle rotated the cookie, or a new sesskey was read. */
  update(change: { cookie?: string; sesskey?: string }): Promise<void> {
    return this.queued(async () => {
      const { key } = this.deps;
      const sessionEnc = change.cookie ? await key.encrypt(change.cookie) : undefined;
      const sesskeyEnc = change.sesskey ? await key.encrypt(change.sesskey) : undefined;
      if (await this.write({ sessionEnc, sesskeyEnc })) this.enc = sessionEnc ?? this.enc;
    });
  }

  /** Moodle answered through the session at `at`: the connection works. */
  confirm(at: number): Promise<boolean> {
    return this.queued(() => this.write({ ...confirmed(at), sessionOkAt: at }));
  }

  /** An attempt failed without the session ending: it waits its turn behind the others. */
  tried(at: number): Promise<boolean> {
    return this.queued(() => this.write({ sessionTriedAt: at }));
  }

  /** Moodle ended the session: it is forgotten. Resolves false when the credential holds another one by now. */
  end(mobileService: boolean): Promise<boolean> {
    return this.queued(async () => {
      const cred = await this.deps.store.getCredential(this.userId);
      if (cred?.sessionEnc !== this.enc) return false;
      const expect = { tokenHash: cred.tokenHash, sessionEnc: this.enc };
      return this.deps.store.updateCredentialIf(this.userId, expect, sessionEnded(cred, mobileService));
    });
  }

  private write(patch: CredentialPatch): Promise<boolean> {
    return this.deps.store.updateCredentialIf(this.userId, { sessionEnc: this.enc }, patch);
  }

  private queued<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(step);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * Moodle rejected this token for good. Without a web session the credential is invalid; with one it stays usable and
 * only the dead token goes (the private token lets the keepalive fetch a new one). A row holding another token by now
 * is left alone.
 */
export async function rejectToken(store: Store, userId: number, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  const invalid = { status: 'invalid' as const, lastError: TOKEN_REJECTED };
  if (await store.updateCredentialIf(userId, { tokenHash, sessionEnc: null }, invalid)) return;
  await store.updateCredentialIf(userId, { tokenHash }, { tokenEnc: null, tokenHash: null, tokenHint: null });
}

export interface RenewalDeps extends CredentialDeps {
  /** Every Moodle request goes through it (the caller meters it). */
  fetch?: typeof fetch;
}

export interface RenewalOutcome {
  /**
   * renewed: a new token was stored; kept: the stored token is current, or the session was touched; ended: Moodle ended
   * the session and nothing replaced it; failed / skipped: none of these.
   */
  status: 'renewed' | 'kept' | 'ended' | 'failed' | 'skipped';
  /** Why it failed or was skipped: a Moodle error code or a short tag, never secret. */
  reason?: string;
  /** Moodle requests made. */
  calls: number;
  /** The current token (a renewal that ended renewed / kept). Never log it. */
  token?: string;
}

/** Whether this many more Moodle requests and store queries may still be spent (default: always). */
type Room = (moodle: number, queries: number) => boolean;

interface RefreshOptions {
  /** May open a session with the private token when there is none (or it ended). Default false. */
  autologin?: boolean;
  room?: Room;
}

/** One step's Moodle requests and store queries (at most: a renewal also writes an audit row). */
const LAUNCH = { moodle: 1, queries: 2 };
const OPEN = { moodle: 3, queries: 4 }; // claim, key, autologin.php, save cookie, launch.php, commit
const TOUCH = { moodle: 1, queries: 2 }; // core_session_touch; an ended session is read and cleared
const FIRST_TOUCH = { moodle: 2, queries: 3 }; // no sesskey stored yet: one page read, and its sesskey saved

type Result = Omit<RenewalOutcome, 'calls'>;
type Cookie = { value: string; enc: string };

/** The store and key, plus the counted fetch every Moodle request of one visit goes through. */
type MeteredDeps = CredentialDeps & { http: typeof fetch };

class Refresh {
  constructor(
    private readonly deps: MeteredDeps,
    private readonly user: UserRow,
    private cred: CredentialRow,
    private readonly opts: RefreshOptions,
  ) {}

  private fits(step: { moodle: number; queries: number }): boolean {
    return this.opts.room?.(step.moodle, step.queries) ?? true;
  }

  /** Writes `patch` only while the credential still is `this.cred` (as far as `session` / autologin are given). */
  private write(patch: CredentialPatch, expect: { sessionEnc?: string | null; autologinAt?: number | null } = {}) {
    return this.deps.store.updateCredentialIf(this.user.id, { tokenHash: this.cred.tokenHash, ...expect }, patch);
  }

  /** Lost a race: the current row's token if another writer stored a usable new one, otherwise nothing. */
  private async current(): Promise<Result> {
    const now = await this.deps.store.getCredential(this.user.id);
    if (now?.status !== 'active' || !now.tokenEnc || now.tokenHash === this.cred.tokenHash) {
      return { status: 'skipped', reason: 'conflict' };
    }
    return { status: 'kept', reason: 'concurrent', token: await this.deps.key.decrypt(now.tokenEnc) };
  }

  async run(): Promise<Result> {
    const { sessionEnc } = this.cred;
    if (!sessionEnc) return this.open();
    if (!this.fits(LAUNCH)) return { status: 'skipped', reason: 'budget' };
    const cookie = { value: await this.deps.key.decrypt(sessionEnc), enc: sessionEnc };
    const r = await this.tryStored(cookie);
    if (r) return r;
    // the session ended: forget it, then (b)
    const forget = sessionEnded(this.cred, true);
    if (!(await this.write(forget, { sessionEnc }))) return this.current();
    this.cred = { ...this.cred, ...forget };
    const reopened = await this.open();
    return reopened.status === 'skipped' ? { status: 'ended' } : reopened;
  }

  /**
   * (a) with the stored session. A failure that is not its end (Moodle unreachable, an odd answer) is stamped, so the
   * session waits its turn behind the others instead of taking every run; its confirmation time stays as it was.
   */
  private async tryStored(cookie: Cookie): Promise<Result | null> {
    try {
      return await this.viaSession(cookie);
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) await this.write({ sessionTriedAt: nowMs() }, { sessionEnc: cookie.enc });
      throw e;
    }
  }

  /** (a) launch.php with the session; null when the session has ended (the caller forgets it). */
  private async viaSession(cookie: Cookie): Promise<Result | null> {
    const r = await launchWithSession(this.deps.http, cookie.value);
    if (!r.ok) return null;
    const now = nowMs();
    const { tokenChanged, patch: tokenPatch } = await tokenColumns(this.deps.key, r.launch, this.cred);
    const patch: CredentialPatch = {
      ...tokenPatch,
      ...confirmed(now),
      sessionEnc: r.cookie === cookie.value ? undefined : await this.deps.key.encrypt(r.cookie),
      sessionOkAt: now,
      renewedAt: tokenChanged ? now : undefined,
    };
    if (!(await this.write(patch, { sessionEnc: cookie.enc }))) return this.current();
    if (tokenChanged) await this.auditRenewal(now);
    return { status: tokenChanged ? 'renewed' : 'kept', token: r.launch.token };
  }

  /** (b) Opens a session with the private token: claim the attempt, open, save the cookie at once, then (a). */
  private async open(): Promise<Result> {
    const { cred } = this;
    const { tokenEnc, privateTokenEnc } = cred;
    if (!this.opts.autologin || cred.status !== 'active' || !tokenEnc || !privateTokenEnc) {
      return { status: 'skipped', reason: 'no_session' };
    }
    const tried = cred.autologinAt ?? null;
    const now = nowMs();
    // a credential connected after the last attempt is new: its private token gets a try at once
    if (tried !== null && tried >= cred.connectedAt && now - tried < AUTOLOGIN_RETRY_MS) {
      return { status: 'skipped', reason: 'retry_later' };
    }
    if (!this.fits(OPEN)) return { status: 'skipped', reason: 'budget' };
    // only the winner of this claim opens a session; a concurrent refresh sees the new stamp and backs off
    if (!(await this.write({ autologinAt: now }, { sessionEnc: null, autologinAt: tried }))) return this.current();
    const [token, privateToken] = await Promise.all([
      this.deps.key.decrypt(tokenEnc),
      this.deps.key.decrypt(privateTokenEnc),
    ]);
    const opened = await openSession(this.deps.http, { token, privateToken, moodleUserId: this.user.moodleUserId });
    if (!opened.ok) return { status: 'failed', reason: opened.reason };
    // saved unconfirmed before launch.php: a failure there leaves the session for the next attempt
    const cookie = { value: opened.cookie, enc: await this.deps.key.encrypt(opened.cookie) };
    const saved = { sessionEnc: cookie.enc, sesskeyEnc: null, sessionOkAt: null, sessionTriedAt: null };
    if (!(await this.write(saved, { sessionEnc: null }))) return this.current();
    const r = await this.viaSession(cookie);
    if (r) return r;
    await this.write({ sessionEnc: null }, { sessionEnc: cookie.enc });
    return { status: 'failed', reason: 'session_ended' };
  }

  private async auditRenewal(at: number): Promise<void> {
    try {
      const row = { userId: this.user.id, at, actor: 'system', action: 'renew', detail: { via: 'session' } };
      await this.deps.store.audit(row);
    } catch {
      /* best effort */
    }
  }
}

/** One `core_session_touch` through the stored session; an ended session is forgotten. */
async function touch(deps: MeteredDeps, user: UserRow, cred: CredentialRow, opts: KeepOptions): Promise<Result> {
  const { sessionEnc, sesskeyEnc } = cred;
  if (!sessionEnc) return { status: 'skipped', reason: 'no_session' };
  const step = sesskeyEnc ? TOUCH : FIRST_TOUCH;
  if (opts.room && !opts.room(step.moodle, step.queries)) return { status: 'skipped', reason: 'budget' };
  const stored = new StoredSession(deps, user.id, sessionEnc);
  const web = new MoodleWebSession({
    cookie: await deps.key.decrypt(sessionEnc),
    sesskey: sesskeyEnc ? await deps.key.decrypt(sesskeyEnc) : null,
    moodleUserId: user.moodleUserId,
    fetch: deps.http,
    charge: () => undefined, // the caller's fetch meters every request
    onUpdate: (change) => stored.update(change).catch(() => undefined),
  });
  try {
    await web.ajax('core_session_touch');
  } catch (e) {
    if (e instanceof NeedsReconnect) {
      await stored.end(opts.mobileService);
      return { status: 'ended' };
    }
    if (!(e instanceof BudgetExceeded)) await stored.tried(nowMs());
    throw e;
  }
  await stored.confirm(nowMs());
  return { status: 'kept' };
}

function failureReason(e: unknown): string {
  if (e instanceof MoodleUnavailable) return 'unavailable';
  if (e instanceof BudgetExceeded) return 'budget';
  return e instanceof MoodleError ? e.errorcode : 'error';
}

/** Runs one visit with its Moodle requests counted. Never throws. */
async function visit(deps: RenewalDeps, job: (metered: MeteredDeps) => Promise<Result>): Promise<RenewalOutcome> {
  let calls = 0;
  const doFetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const http: typeof fetch = (input, init) => {
    calls++;
    return doFetch(input, init);
  };
  try {
    return { ...(await job({ ...deps, http })), calls };
  } catch (e) {
    return { status: 'failed', reason: failureReason(e), calls };
  }
}

/**
 * (a) A stored session -> launch.php: the token it returns is stored (a new one, or the same one confirmed, which also
 * brings an `invalid` credential back); an ended session is forgotten and (b) follows. (b) With `autologin`, an active
 * credential with a private token opens a session (at most once per AUTOLOGIN_RETRY_MS unless it was connected since),
 * then as (a). (c) Otherwise nothing: a manual reconnect is needed. Only for use while the mobile web service is on.
 * `cred` is the row as the caller read it. Never throws; the outcome says what happened.
 */
export function refreshCredential(
  deps: RenewalDeps,
  user: UserRow,
  cred: CredentialRow,
  opts: RefreshOptions = {},
): Promise<RenewalOutcome> {
  return visit(deps, (metered) => new Refresh(metered, user, cred, opts).run());
}

interface KeepOptions {
  /** The site flag: the mobile web service is on. */
  mobileService: boolean;
  room?: Room;
}

/**
 * The keepalive's visit of one stored session: with the mobile web service on and a private token through the token
 * renewal (launch.php), otherwise one `core_session_touch`. Never throws.
 */
export function keepSession(
  deps: RenewalDeps,
  user: UserRow,
  cred: CredentialRow,
  opts: KeepOptions,
): Promise<RenewalOutcome> {
  if (opts.mobileService && cred.privateTokenEnc) {
    return refreshCredential(deps, user, cred, { autologin: true, room: opts.room });
  }
  return visit(deps, (metered) => touch(metered, user, cred, opts));
}
