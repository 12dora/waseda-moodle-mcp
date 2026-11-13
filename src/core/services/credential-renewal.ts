/**
 * Automatic credential renewal. Waseda Moodle tokens live about a week; a Moodle web session asks launch.php for the
 * current token, and Moodle issues a new one there once the old one expired. The session is opened with the private
 * token (autologin: the cron and right after a connect only, never inside a tool call) and kept alive by the cron
 * (Moodle ends it after 4 h idle). Protocol: moodle/web-session.
 *
 * Every write is a compare-and-set on the credential as it was read (token hash, session cookie, autologin stamp):
 * a refresh that lost a race to another refresh, a reconnect or an invalidation never overwrites the newer state;
 * it reads the current row instead.
 */

import type { CredentialPatch, CredentialRow, UserRow } from '../context';
import { BudgetExceeded, MoodleUnavailable } from '../errors';
import { launchWithSession, openSession } from '../moodle/web-session';
import { nowMs } from '../time';
import { type CredentialDeps, tokenColumns } from './account';

/** Moodle ends an idle web session after this long. */
export const SESSION_IDLE_MS = 4 * 3_600_000;
/** After an autologin attempt the next one waits this long, unless the credential was connected since. */
export const AUTOLOGIN_RETRY_MS = 6 * 3_600_000;

export interface RenewalDeps extends CredentialDeps {
  /** Every Moodle request goes through it (the caller meters it). */
  fetch?: typeof fetch;
}

export interface RenewalOutcome {
  /** renewed: a new token was stored; kept: the stored token is current; failed / skipped: neither. */
  status: 'renewed' | 'kept' | 'failed' | 'skipped';
  /** Why it failed or was skipped: a Moodle error code or a short tag, never secret. */
  reason?: string;
  /** Moodle requests made. */
  calls: number;
  /** The current token (renewed / kept). Never log it. */
  token?: string;
}

interface RefreshOptions {
  /** May open a session with the private token when there is none (or it ended). Default false. */
  autologin?: boolean;
  /** Whether this many more Moodle requests and store queries may still be spent (default: always). */
  room?: (moodle: number, queries: number) => boolean;
}

/** One step's Moodle requests and store queries (at most: a renewal also writes an audit row). */
const LAUNCH = { moodle: 1, queries: 2 };
const OPEN = { moodle: 3, queries: 4 }; // claim, key, autologin.php, save cookie, launch.php, commit

type Result = Omit<RenewalOutcome, 'calls'>;
type Cookie = { value: string; enc: string };

const confirmed = (now: number) => ({ status: 'active' as const, lastOkAt: now, lastError: null });

/** The store and key, plus the metered fetch every Moodle request of one refresh goes through. */
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
    if (now?.status !== 'active' || now.tokenHash === this.cred.tokenHash) {
      return { status: 'skipped', reason: 'conflict' };
    }
    return { status: 'kept', reason: 'concurrent', token: await this.deps.key.decrypt(now.tokenEnc) };
  }

  async run(): Promise<Result> {
    const { sessionEnc } = this.cred;
    if (sessionEnc) {
      if (!this.fits(LAUNCH)) return { status: 'skipped', reason: 'budget' };
      const cookie = { value: await this.deps.key.decrypt(sessionEnc), enc: sessionEnc };
      const r = await this.tryStored(cookie);
      if (r) return r;
      // the session ended: forget it, then (b)
      const forget = { sessionEnc: null, sessionOkAt: null, sessionTriedAt: null };
      if (!(await this.write(forget, { sessionEnc }))) return this.current();
      this.cred = { ...this.cred, ...forget };
    }
    return this.open();
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
    if (!this.opts.autologin || cred.status !== 'active' || !cred.privateTokenEnc) {
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
      this.deps.key.decrypt(cred.tokenEnc),
      this.deps.key.decrypt(cred.privateTokenEnc),
    ]);
    const opened = await openSession(this.deps.http, { token, privateToken, moodleUserId: this.user.moodleUserId });
    if (!opened.ok) return { status: 'failed', reason: opened.reason };
    // saved unconfirmed before launch.php: a failure there leaves the session for the next attempt
    const cookie = { value: opened.cookie, enc: await this.deps.key.encrypt(opened.cookie) };
    const saved = { sessionEnc: cookie.enc, sessionOkAt: null, sessionTriedAt: null };
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

function failureReason(e: unknown): string {
  if (e instanceof MoodleUnavailable) return 'unavailable';
  if (e instanceof BudgetExceeded) return 'budget';
  return 'error';
}

/**
 * (a) A stored session -> launch.php: the token it returns is stored (a new one, or the same one confirmed, which
 * also brings an `invalid` credential back); an ended session is forgotten and (b) follows. (b) With `autologin`, an
 * active credential with a private token opens a session (at most once per AUTOLOGIN_RETRY_MS unless it was connected
 * since), then as (a). (c) Otherwise nothing: a manual reconnect is needed. `cred` is the row as the caller read it.
 * Never throws; the outcome says what happened.
 */
export async function refreshCredential(
  deps: RenewalDeps,
  user: UserRow,
  cred: CredentialRow,
  opts: RefreshOptions = {},
): Promise<RenewalOutcome> {
  let calls = 0;
  const doFetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const http: typeof fetch = (input, init) => {
    calls++;
    return doFetch(input, init);
  };
  try {
    return { ...(await new Refresh({ ...deps, http }, user, cred, opts).run()), calls };
  } catch (e) {
    return { status: 'failed', reason: failureReason(e), calls };
  }
}
