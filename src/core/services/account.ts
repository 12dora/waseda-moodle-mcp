/** Account connection: Moodle launch token -> verified user + encrypted credential. Shared by worker and stdio. */

import type { CredentialRow, MoodleApi, Store, UserRow } from '../context';
import { type MasterKey, sha256Hex } from '../crypto';
import { Forbidden, InvalidInput, MoodleError, NeedsReconnect, NotFound, WmmError } from '../errors';
import { type LaunchToken, MOODLE_URL, parseLaunch } from '../moodle/launch';
import { isoJst, nowMs } from '../time';
import { type ConnectVia, type CredentialInfo, DEFAULT_SETTINGS, type UserInfo } from '../types';

/** What writing a credential needs (connect, extension refresh, automatic renewal). */
export interface CredentialDeps {
  store: Store;
  key: MasterKey;
}

export interface ConnectDeps extends CredentialDeps {
  /** Client for a not-yet-stored token; moodleUserId 0 means "not known yet". */
  makeClient(token: string, moodleUserId: number): MoodleApi;
  allowRegistration(moodleUserId: number): boolean;
}

export interface ConnectResult {
  user: UserRow;
  created: boolean;
  tokenChanged: boolean;
}

interface SiteInfo {
  siteurl?: unknown;
  userid?: unknown;
  fullname?: unknown;
  username?: unknown;
  lang?: unknown;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '').toLowerCase();

/** Validates the token against the site and returns who it belongs to. Never stores anything. */
async function identify(deps: ConnectDeps, launch: string, passport?: string) {
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
  return { parsed, moodleUserId: userid, fullname, lang };
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
  opts: { via: ConnectVia; silent: boolean },
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
    if (!current) throw new NotFound('No account is connected for this Moodle user.');
    if (opts.silent && current.status === 'active' && current.tokenHash !== columns.tokenHash) return false;
    previous = current;
  }
  throw new WmmError('The connection changed while it was being saved. Try again.', 'conflict');
}

const AUDIT_ACTOR: Record<ConnectVia, string> = {
  bookmarklet: 'console',
  paste: 'console',
  extension: 'extension',
  stdio: 'system',
};

async function auditConnect(deps: ConnectDeps, userId: number, via: ConnectVia, detail: Record<string, unknown>) {
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

export async function connectFromLaunch(
  deps: ConnectDeps,
  input: { launch: string; via: ConnectVia; passport?: string },
): Promise<ConnectResult> {
  const who = await identify(deps, input.launch, input.passport);
  const existing = await deps.store.getUserByMoodleId(who.moodleUserId);
  if (!existing && !deps.allowRegistration(who.moodleUserId)) {
    throw new Forbidden('This service is not open for new accounts yet.');
  }
  const user = await deps.store.upsertUser({ moodleUserId: who.moodleUserId, fullname: who.fullname, lang: who.lang });
  const tokenChanged = await storeCredential(deps, user.id, who.parsed, { via: input.via, silent: false });
  const created = !existing;
  await auditConnect(deps, user.id, input.via, { created, tokenChanged });
  return { user, created, tokenChanged };
}

/** Extension refresh: same verification, but only for existing users and never creates anything. */
export async function refreshFromLaunch(
  deps: ConnectDeps,
  input: { launch: string; passport?: string },
): Promise<{ user: UserRow; tokenChanged: boolean }> {
  const who = await identify(deps, input.launch, input.passport);
  const existing = await deps.store.getUserByMoodleId(who.moodleUserId);
  if (!existing) throw new NotFound('No account is connected for this Moodle user.');
  const tokenChanged = await storeCredential(deps, existing.id, who.parsed, { via: 'extension', silent: true });
  await auditConnect(deps, existing.id, 'extension', { refresh: true, tokenChanged });
  return { user: existing, tokenChanged };
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

/** A web session renews the token; without one, an active credential with a private token can open it. */
const canRenew = (row: CredentialRow): boolean =>
  Boolean(row.sessionEnc) || (row.status === 'active' && row.privateTokenEnc !== null);

export function toCredentialInfo(row: CredentialRow): CredentialInfo {
  return {
    status: row.status,
    connectedVia: row.connectedVia,
    connectedAt: isoJst(row.connectedAt),
    lastOkAt: row.lastOkAt === null ? null : isoJst(row.lastOkAt),
    lastError: row.lastError,
    tokenHint: row.tokenHint,
    autoRenew: canRenew(row),
    renewedAt: row.renewedAt ? isoJst(row.renewedAt) : null,
  };
}
