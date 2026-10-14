/** Account connection: Moodle launch token -> verified user + encrypted credential. Shared by worker and stdio. */

import type { CredentialRow, MoodleApi, Store, UserRow } from '../context';
import { type MasterKey, sha256Hex } from '../crypto';
import { Forbidden, InvalidInput, MoodleError, NeedsReconnect, NotFound } from '../errors';
import { type LaunchToken, MOODLE_URL, parseLaunch } from '../moodle/launch';
import { isoJst, nowMs } from '../time';
import { type ConnectVia, type CredentialInfo, DEFAULT_SETTINGS, type UserInfo } from '../types';

export interface ConnectDeps {
  store: Store;
  key: MasterKey;
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

/** Keeps the old private token when the same token is re-sent without one. */
async function privateTokenFor(
  deps: ConnectDeps,
  privateToken: string | null,
  previous: CredentialRow | null,
  tokenChanged: boolean,
): Promise<string | null> {
  if (privateToken) return deps.key.encrypt(privateToken);
  return tokenChanged ? null : (previous?.privateTokenEnc ?? null);
}

/** Silent refresh with the same token: confirm it still works and keep a private token that newly arrived. */
async function confirmSameToken(
  deps: ConnectDeps,
  previous: CredentialRow,
  privateToken: string | null,
): Promise<false> {
  const confirmed = { status: 'active' as const, lastOkAt: nowMs(), lastError: null };
  if (privateToken) {
    await deps.store.putCredential({
      ...previous,
      ...confirmed,
      privateTokenEnc: await deps.key.encrypt(privateToken),
    });
  } else {
    await deps.store.updateCredentialStatus(previous.userId, confirmed);
  }
  return false;
}

/** Writes the credential. Returns whether the stored token differs from the previous one. */
async function storeCredential(
  deps: ConnectDeps,
  userId: number,
  launch: LaunchToken,
  opts: { via: ConnectVia; silent: boolean },
): Promise<boolean> {
  const now = nowMs();
  const { token } = launch;
  const [tokenHash, previous] = await Promise.all([sha256Hex(token), deps.store.getCredential(userId)]);
  const tokenChanged = !previous || previous.tokenHash !== tokenHash;
  if (previous && !tokenChanged && opts.silent) return confirmSameToken(deps, previous, launch.privateToken);
  await deps.store.putCredential({
    userId,
    tokenEnc: await deps.key.encrypt(token),
    privateTokenEnc: await privateTokenFor(deps, launch.privateToken, previous, tokenChanged),
    tokenHash,
    tokenHint: token.slice(-4),
    status: 'active',
    connectedVia: opts.via,
    connectedAt: now,
    lastOkAt: now,
    lastError: null,
  });
  return tokenChanged;
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

export function toCredentialInfo(row: CredentialRow): CredentialInfo {
  return {
    status: row.status,
    connectedVia: row.connectedVia,
    connectedAt: isoJst(row.connectedAt),
    lastOkAt: row.lastOkAt === null ? null : isoJst(row.lastOkAt),
    lastError: row.lastError,
    tokenHint: row.tokenHint,
  };
}
