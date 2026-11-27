/**
 * Account connection: a Moodle web session (the MoodleSession cookie) or a Moodle app launch link -> verified user +
 * encrypted credential. Shared by worker and stdio.
 */

import type { CredentialRow, MoodleApi, Store, UserRow } from '../context';
import { type MasterKey, sha256Hex } from '../crypto';
import { Forbidden, InvalidInput, MoodleError, NeedsReconnect, NotFound, WmmError } from '../errors';
import { type LaunchToken, MOODLE_URL, parseLaunch } from '../moodle/launch';
import { identifySession, normalizeSessionCookie } from '../moodle/web/identify';
import { isoJst, nowMs } from '../time';
import { type CredentialInfo, DEFAULT_SETTINGS, type SignInVia, type UserInfo } from '../types';

/** What writing a credential needs (connect, extension refresh, automatic renewal). */
export interface CredentialDeps {
  store: Store;
  key: MasterKey;
}

export interface ConnectDeps extends CredentialDeps {
  /** Client for a not-yet-stored token; moodleUserId 0 means "not known yet". */
  makeClient(token: string, moodleUserId: number): MoodleApi;
  allowRegistration(moodleUserId: number): boolean;
  /** The Moodle requests of a session sign-in (default: global fetch). */
  fetch?: typeof fetch;
  /** Moodle answered for a launch token, so its mobile web service is on. */
  onTokenVerified?: () => Promise<void>;
}

/** What a sign-in carries: the web session, the launch link, or both (the session then leads). */
export interface SignInInput {
  via: SignInVia;
  session?: string;
  launch?: string;
  passport?: string;
}

export interface ConnectResult {
  user: UserRow;
  created: boolean;
  /** The stored session (or, for a launch link, token) differs from the previous one. */
  changed: boolean;
}

/** Who a verified sign-in belongs to; `lang` null = Moodle did not say. */
interface Identity {
  moodleUserId: number;
  fullname: string;
  lang: string | null;
}

interface SiteInfo {
  siteurl?: unknown;
  userid?: unknown;
  fullname?: unknown;
  username?: unknown;
  lang?: unknown;
}

const NO_ACCOUNT = 'No account is connected for this Moodle user.';
const SERVICE_OFF =
  'Waseda Moodle turned off the app service. Reconnect with the browser extension or the Moodle session cookie.';

const trimSlash = (s: string) => s.replace(/\/+$/, '').toLowerCase();

/** Validates the launch token against the site and returns who it belongs to. Never stores anything. */
async function identifyLaunch(deps: ConnectDeps, launch: string, passport?: string) {
  const parsed = parseLaunch(launch, passport);
  if (parsed.signatureOk === false) {
    throw new InvalidInput('This link was created for a different sign-in. Generate a new one.');
  }
  let info: SiteInfo;
  try {
    info = await deps.makeClient(parsed.token, 0).call<SiteInfo>('core_webservice_get_site_info');
  } catch (e) {
    if (e instanceof NeedsReconnect || (e instanceof MoodleError && e.errorcode === 'invalidtoken')) {
      throw new InvalidInput('Moodle did not accept this sign-in link. Open the Moodle login link again and retry.');
    }
    throw e;
  }
  if (typeof info?.siteurl !== 'string' || trimSlash(info.siteurl) !== trimSlash(MOODLE_URL)) {
    throw new InvalidInput('This token does not belong to Waseda Moodle.');
  }
  const userid = info.userid;
  if (typeof userid !== 'number' || !Number.isInteger(userid) || userid <= 0) {
    throw new InvalidInput('Moodle did not report a user for this token.');
  }
  const name = (typeof info.fullname === 'string' ? info.fullname : '').replace(/\s+/g, ' ').trim();
  const fullname = name || (typeof info.username === 'string' ? info.username : '') || `User ${userid}`;
  const lang = typeof info.lang === 'string' && info.lang ? info.lang : 'en';
  await deps.onTokenVerified?.();
  return { parsed, moodleUserId: userid, fullname, lang };
}

/**
 * Reads the user of a pasted or extension-sent session cookie (an ended session: NeedsReconnect). Never stores
 * anything.
 */
async function identifyCookie(deps: ConnectDeps, session: string) {
  const cookie = normalizeSessionCookie(session);
  const doFetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const who = await identifySession(doFetch, cookie);
  return { ...who, fullname: who.fullname.trim() || `User ${who.moodleUserId}` };
}

/** The account of a verified Moodle user, created when new (and allowed); name and language are refreshed. */
async function register(deps: ConnectDeps, who: Identity): Promise<{ user: UserRow; created: boolean }> {
  const existing = await deps.store.getUserByMoodleId(who.moodleUserId);
  if (!existing && !deps.allowRegistration(who.moodleUserId)) {
    throw new Forbidden('This service is not open for new accounts yet.');
  }
  const { moodleUserId, fullname } = who;
  const lang = who.lang ?? existing?.lang ?? 'en';
  const user = await deps.store.upsertUser({ moodleUserId, fullname, lang });
  return { user, created: !existing };
}

type TokenColumns = Pick<CredentialRow, 'tokenEnc' | 'privateTokenEnc' | 'tokenHash' | 'tokenHint'>;

/**
 * The token columns for `launch` over the stored row. `columns` is the whole set (a new row); `patch` changes only
 * what `launch` changes: a new token with its private token or none, or for the same token only a private token that
 * arrived, so a concurrent writer's private token is never overwritten with a stale value.
 */
export async function tokenColumns(
  key: MasterKey,
  launch: LaunchToken,
  previous: CredentialRow | null,
): Promise<{ tokenChanged: boolean; columns: TokenColumns; patch: Partial<TokenColumns> }> {
  const tokenHash = await sha256Hex(launch.token);
  const tokenChanged = !previous || previous.tokenHash !== tokenHash;
  const arrived = launch.privateToken ? await key.encrypt(launch.privateToken) : null;
  const columns: TokenColumns = {
    tokenEnc: await key.encrypt(launch.token),
    privateTokenEnc: arrived ?? (tokenChanged ? null : (previous?.privateTokenEnc ?? null)),
    tokenHash,
    tokenHint: launch.token.slice(-4),
  };
  if (tokenChanged) return { tokenChanged, columns, patch: columns };
  return { tokenChanged, columns, patch: arrived ? { privateTokenEnc: arrived } : {} };
}

/** Conflicting writers in a row before a connect gives up (each one stored a different token meanwhile). */
const STORE_ATTEMPTS = 3;

/** The status columns of a credential Moodle just accepted. */
export const confirmed = (now: number) => ({ status: 'active' as const, lastOkAt: now, lastError: null });

/**
 * Writes the credential. Returns whether the stored token differs from the previous one. `silent` (extension
 * refresh): the same token only confirms the credential (and stores a private token that arrived).
 *
 * An existing row is changed only by a compare-and-set on the token it was read with (the protocol renewal uses), so
 * a private token is always stored with the token it came with. On a conflict the current row is read again: a silent
 * refresh yields to an active credential with another token (a renewal or reconnect is at least as new); otherwise
 * the write is computed again against the current row.
 */
async function storeCredential(
  deps: CredentialDeps,
  userId: number,
  launch: LaunchToken,
  opts: { via: SignInVia; silent: boolean },
): Promise<boolean> {
  let previous = await deps.store.getCredential(userId);
  if (!previous) {
    const now = nowMs();
    const { columns } = await tokenColumns(deps.key, launch, null);
    await deps.store.putCredential({ userId, ...columns, ...confirmed(now), connectedVia: opts.via, connectedAt: now });
    return true;
  }
  for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt++) {
    const now = nowMs();
    const { tokenChanged, columns, patch } = await tokenColumns(deps.key, launch, previous);
    const origin = !tokenChanged && opts.silent ? {} : { connectedVia: opts.via, connectedAt: now };
    const update = { ...patch, ...confirmed(now), ...origin };
    if (await deps.store.updateCredentialIf(userId, { tokenHash: previous.tokenHash }, update)) return tokenChanged;
    const current = await deps.store.getCredential(userId);
    if (!current) throw new NotFound(NO_ACCOUNT);
    if (opts.silent && current.status === 'active' && current.tokenHash !== columns.tokenHash) return false;
    previous = current;
  }
  throw new WmmError('The connection changed while it was being saved. Try again.', 'conflict');
}

/**
 * Writes a verified web session; a stored app token stays (it is this user's: both channels). Returns whether the
 * cookie differs from the stored one. `silent` (extension refresh): the same cookie only confirms the connection.
 */
async function storeSession(
  deps: CredentialDeps,
  userId: number,
  found: { cookie: string; sesskey: string },
  opts: { via: SignInVia; silent: boolean },
): Promise<boolean> {
  const previous = await deps.store.getCredential(userId);
  const now = nowMs();
  const changed = !previous?.sessionEnc || (await deps.key.decrypt(previous.sessionEnc)) !== found.cookie;
  const origin = { connectedVia: opts.via, connectedAt: now };
  if (!previous) {
    const noToken = { tokenEnc: null, privateTokenEnc: null, tokenHash: null, tokenHint: null };
    await deps.store.putCredential({ userId, ...noToken, ...confirmed(now), ...origin });
  }
  await deps.store.updateCredentialStatus(userId, {
    sessionEnc: changed ? await deps.key.encrypt(found.cookie) : undefined,
    sesskeyEnc: await deps.key.encrypt(found.sesskey),
    sessionOkAt: now,
    sessionTriedAt: null,
    ...confirmed(now),
    ...(changed || !opts.silent ? origin : {}),
  });
  return changed;
}

/**
 * The app token a session sign-in may carry as well: stored only for the same Moodle user, and never failing the
 * sign-in (the mobile web service may be off).
 */
async function storeExtraToken(deps: ConnectDeps, user: UserRow, input: SignInInput): Promise<void> {
  if (!input.launch) return;
  try {
    const { parsed, moodleUserId } = await identifyLaunch(deps, input.launch, input.passport);
    if (moodleUserId !== user.moodleUserId) return;
    await storeCredential(deps, user.id, parsed, { via: input.via, silent: true });
  } catch {
    /* the session alone connects the account */
  }
}

const AUDIT_ACTOR: Record<SignInVia, string> = {
  paste: 'console',
  extension: 'extension',
  stdio: 'system',
};

async function auditConnect(deps: ConnectDeps, userId: number, via: SignInVia, detail: Record<string, unknown>) {
  try {
    await deps.store.audit({
      userId,
      at: nowMs(),
      actor: AUDIT_ACTOR[via],
      action: 'connect',
      detail: { via, ...detail },
    });
  } catch {
    /* best effort */
  }
}

export async function connectFromSession(
  deps: ConnectDeps,
  input: SignInInput & { session: string },
): Promise<ConnectResult> {
  const who = await identifyCookie(deps, input.session);
  const { user, created } = await register(deps, who);
  const changed = await storeSession(deps, user.id, who, { via: input.via, silent: false });
  await storeExtraToken(deps, user, input);
  await auditConnect(deps, user.id, input.via, { created, channel: 'web', changed });
  return { user, created, changed };
}

export async function connectFromLaunch(
  deps: ConnectDeps,
  input: SignInInput & { launch: string },
): Promise<ConnectResult> {
  const who = await identifyLaunch(deps, input.launch, input.passport);
  const { user, created } = await register(deps, who);
  const changed = await storeCredential(deps, user.id, who.parsed, { via: input.via, silent: false });
  await auditConnect(deps, user.id, input.via, { created, channel: 'ws', changed });
  return { user, created, changed };
}

/** A sign-in from the console or a hand-off: by the web session when one is sent, else by the launch link. */
export function connectAccount(deps: ConnectDeps, input: SignInInput): Promise<ConnectResult> {
  const { session, launch } = input;
  if (session) return connectFromSession(deps, { ...input, session });
  if (launch) return connectFromLaunch(deps, { ...input, launch });
  return Promise.reject(new InvalidInput('Send the Moodle session or a launch link.'));
}

/** The account of a verified sign-in that must exist already (silent refresh never creates anything). */
async function existingUser(deps: ConnectDeps, moodleUserId: number): Promise<UserRow> {
  const user = await deps.store.getUserByMoodleId(moodleUserId);
  if (!user) throw new NotFound(NO_ACCOUNT);
  return user;
}

/**
 * Extension refresh with the browser's session (the user signed in to Moodle again): replaces the stored one of an
 * existing user, so no reconnect is needed. `admit` runs once the user is known, before anything is written.
 */
export async function refreshFromSession(
  deps: ConnectDeps,
  input: Omit<SignInInput, 'via'> & { session: string; admit?: (user: UserRow) => Promise<void> },
): Promise<{ user: UserRow; changed: boolean }> {
  const who = await identifyCookie(deps, input.session);
  const user = await existingUser(deps, who.moodleUserId);
  await input.admit?.(user);
  const changed = await storeSession(deps, user.id, who, { via: 'extension', silent: true });
  await storeExtraToken(deps, user, { ...input, via: 'extension' });
  await auditConnect(deps, user.id, 'extension', { refresh: true, channel: 'web', changed });
  return { user, changed };
}

/** Extension refresh with a launch link: same verification, but only for existing users and never creates anything. */
export async function refreshFromLaunch(
  deps: ConnectDeps,
  input: { launch: string; passport?: string },
): Promise<{ user: UserRow; changed: boolean }> {
  const who = await identifyLaunch(deps, input.launch, input.passport);
  const user = await existingUser(deps, who.moodleUserId);
  const changed = await storeCredential(deps, user.id, who.parsed, { via: 'extension', silent: true });
  await auditConnect(deps, user.id, 'extension', { refresh: true, channel: 'ws', changed });
  return { user, changed };
}

export function toUserInfo(row: UserRow): UserInfo {
  return {
    id: row.id,
    moodleUserId: row.moodleUserId,
    fullname: row.fullname,
    lang: row.lang,
    settings: { ...DEFAULT_SETTINGS, ...row.settings },
    createdAt: isoJst(row.createdAt),
  };
}

/**
 * Whether a stored credential can reach Moodle now: through its web session, or with an accepted app token while the
 * mobile web service is on.
 */
export function isUsable(row: CredentialRow, mobileService: boolean): boolean {
  return Boolean(row.sessionEnc) || (mobileService && row.status === 'active' && Boolean(row.tokenEnc));
}

export function toCredentialInfo(row: CredentialRow, mobileService: boolean): CredentialInfo {
  const usable = isUsable(row, mobileService);
  return {
    status: usable ? 'active' : 'invalid',
    connectedVia: row.connectedVia,
    connectedAt: isoJst(row.connectedAt),
    lastOkAt: row.lastOkAt === null ? null : isoJst(row.lastOkAt),
    // an active row that is unusable holds only a token the site no longer serves
    lastError: usable ? null : (row.lastError ?? SERVICE_OFF),
    sessionOkAt: row.sessionOkAt ? isoJst(row.sessionOkAt) : null,
  };
}
