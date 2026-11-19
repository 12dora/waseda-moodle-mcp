/**
 * Waseda mail connection (Google OAuth, authorization code + PKCE): POST /api/mail/connect parks the state and returns
 * Google's consent URL, GET /api/google/callback stores the refresh token, DELETE /api/mail revokes it. The console
 * reads the state from GET /api/me (`mail`, built by mailInfo).
 */

import { type Context, Hono } from 'hono';
import type { MailCredentialRow, UserRow } from '../../core/context';
import { b64urlDecode, b64urlEncode, randomId } from '../../core/crypto';
import { Forbidden, NotFound, WmmError } from '../../core/errors';
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, GOOGLE_TOKEN_URL, revokeGoogleToken } from '../../core/mail/client';
import { type AppEnv, deferOn, hostCookie, memoryRateLimit, readCookie } from '../auth';
import { getRuntime } from '../context';
import { type Env, googleClientOf, mailIdleDaysOf, mailSlotsOf, publicUrlOf } from '../env';
import type { D1Store } from '../store-d1';
import { auditConsole, optionalSessionUser, session } from './shared';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const SCOPES = ['openid', 'email', GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE];
const STATE_TTL_SEC = 600;
const STATE_COOKIE = '__Host-wmm_gml';
const STATE_PREFIX = 'gml';
const WASEDA_ADDRESS = /^[^@\s]+@([a-z0-9-]+\.)*waseda\.jp$/i;
/** The `hd` claim (hosted domain): present only for Google Workspace accounts, not for a consumer account. */
const WASEDA_HD = /^([a-z0-9-]+\.)*waseda\.jp$/i;
const SLOTS_FULL = 'Mail slots are full. Self-host the server to use mail.';

type GoogleClient = NonNullable<ReturnType<typeof googleClientOf>>;
type ConnectResult = 'connected' | 'denied' | 'expired' | 'domain' | 'scope' | 'full' | 'failed' | 'session';

/** Parked between connect and callback (encrypted in oauth_requests). */
interface PendingMail {
  userId: number;
  verifier: string;
  nonce: string;
}

interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  idToken: string;
}

/** The Google account behind a grant (verified id_token claims). `address` is lower-cased; `hd` '' when absent. */
interface GoogleIdentity {
  sub: string;
  address: string;
  hd: string;
}

/** What Google issued in this callback; `identity` null when the id_token did not verify. */
interface IssuedGrant {
  tokens: GoogleTokens;
  identity: GoogleIdentity | null;
}

/** A grant fit to be stored. */
interface AcceptedGrant {
  identity: GoogleIdentity;
  refreshToken: string;
  scopes: string[];
}

/** Ends the callback with `result`; `revoke` is a token Google just issued that must not stay alive. */
class ConnectStop extends Error {
  constructor(
    readonly result: ConnectResult,
    readonly revoke?: string,
  ) {
    super(result);
  }
}

const doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const redirectUri = (env: Env): string => `${publicUrlOf(env)}/api/google/callback`;
const b64url = (bytes: ArrayBuffer | Uint8Array): string => b64urlEncode(new Uint8Array(bytes));

/** The user may connect: unlimited slots, a slot of their own (a returning user), or slots left. */
async function slotAvailable(env: Env, store: D1Store, moodleUserId: number): Promise<boolean> {
  const limit = mailSlotsOf(env);
  if (limit === null || (await store.hasMailSlot(moodleUserId))) return true;
  return (await store.countMailSlots()) < limit;
}

/**
 * Parks the PKCE verifier and nonce for this user; answers Google's consent URL. Google always shows its account
 * picker (a personal Gmail signed in must not be used silently: every account that consents counts against Google's
 * user cap); a reconnect suggests the stored address.
 */
async function startConnect(c: Context<AppEnv>, google: GoogleClient, user: UserRow): Promise<string> {
  const rt = await getRuntime(c.env);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const id = randomId(STATE_PREFIX, 16);
  const now = Date.now();
  const pending: PendingMail = { userId: user.id, verifier, nonce };
  const stored = await rt.store.getMailCredential(user.id);
  await rt.store.putOAuthRequest({
    id,
    payloadEnc: await rt.key.encrypt(JSON.stringify(pending)),
    createdAt: now,
    expiresAt: now + STATE_TTL_SEC * 1000,
  });
  c.header('Set-Cookie', hostCookie(STATE_COOKIE, id, STATE_TTL_SEC));
  const url = new URL(GOOGLE_AUTH_URL);
  const params = {
    client_id: google.clientId,
    redirect_uri: redirectUri(c.env),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'false',
    state: id,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(stored ? { login_hint: stored.address } : {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** The parked state of this browser and this user (consumed); null when unknown, expired or not theirs. */
async function takePending(c: Context<AppEnv>, user: UserRow): Promise<PendingMail | null> {
  const state = c.req.query('state') ?? '';
  if (!state.startsWith(`${STATE_PREFIX}_`) || state.length > 100) return null;
  if (readCookie(c.req.raw, STATE_COOKIE) !== state) return null;
  const rt = await getRuntime(c.env);
  const enc = await rt.store.takeOAuthRequest(state, Date.now());
  if (!enc) return null;
  const pending = JSON.parse(await rt.key.decrypt(enc)) as PendingMail;
  return pending.userId === user.id ? pending : null;
}

async function exchangeCode(env: Env, google: GoogleClient, code: string, verifier: string): Promise<GoogleTokens> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(env),
    client_id: google.clientId,
    client_secret: google.clientSecret,
  });
  const res = await doFetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(25_000),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok || !isObj(json) || typeof json.access_token !== 'string') throw new ConnectStop('failed');
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : null;
  const idToken = typeof json.id_token === 'string' ? json.id_token : '';
  const scopes = typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : [];
  return { accessToken: json.access_token, refreshToken, scopes, idToken };
}

/**
 * The Google account in the id_token. It came straight from Google's token endpoint over TLS, so its claims are
 * checked (audience, issuer, nonce, verified email) without verifying the signature.
 */
function verifiedIdentity(idToken: string, google: GoogleClient, nonce: string): GoogleIdentity | null {
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(idToken.split('.')[1] ?? '')));
  } catch {
    return null;
  }
  if (!isObj(claims) || claims.aud !== google.clientId || claims.nonce !== nonce) return null;
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) return null;
  if (claims.email_verified !== true || typeof claims.email !== 'string' || typeof claims.sub !== 'string') return null;
  const hd = typeof claims.hd === 'string' ? claims.hd : '';
  return { sub: claims.sub, address: claims.email.toLowerCase(), hd };
}

/** The stored row holds a token of the account `id` (by Google account id; by address for a row stored without it). */
function holdsSameAccount(row: MailCredentialRow, id: GoogleIdentity): boolean {
  if (!row.refreshEnc) return false;
  return row.googleSub ? row.googleSub === id.sub : row.address === id.address;
}

/** Takes the slot and checks what Google granted; throws ConnectStop when the grant is unusable. */
async function acceptGrant(env: Env, user: UserRow, grant: IssuedGrant): Promise<AcceptedGrant> {
  const rt = await getRuntime(env);
  // Google counted the user once the code was issued: the slot is taken even when the grant is unusable below
  if (!(await rt.store.takeMailSlot(user.moodleUserId, Date.now(), mailSlotsOf(env)))) throw new ConnectStop('full');
  const { identity, tokens } = grant;
  if (!identity) throw new ConnectStop('failed');
  if (!WASEDA_ADDRESS.test(identity.address) || !WASEDA_HD.test(identity.hd)) throw new ConnectStop('domain');
  if (!tokens.scopes.includes(GMAIL_READ_SCOPE)) throw new ConnectStop('scope');
  if (!tokens.refreshToken) throw new ConnectStop('failed');
  return { identity, refreshToken: tokens.refreshToken, scopes: tokens.scopes };
}

/**
 * Stores the new connection over `stored`. The previous token of ANOTHER Google account is revoked at Google once the
 * new row is stored (best effort). The same account's previous token is only dropped: Google's revoke would end the
 * app's whole grant for that account, the new token included (Google's per-client token limit evicts the old one).
 */
async function storeConnection(
  c: Context<AppEnv>,
  user: UserRow,
  grant: AcceptedGrant,
  stored: MailCredentialRow | null,
): Promise<void> {
  const rt = await getRuntime(c.env);
  const oldEnc = stored && !holdsSameAccount(stored, grant.identity) ? stored.refreshEnc : null;
  const oldRefresh = oldEnc ? await rt.key.decrypt(oldEnc).catch(() => null) : null;
  await rt.store.putMailCredential({
    userId: user.id,
    address: grant.identity.address,
    googleSub: grant.identity.sub,
    refreshEnc: await rt.key.encrypt(grant.refreshToken),
    scopes: grant.scopes,
    status: 'active',
    connectedAt: Date.now(),
    lastUsedAt: null,
    lastError: null,
    idleTriedAt: null,
  });
  if (oldRefresh && oldRefresh !== grant.refreshToken) deferOn(c, revokeGoogleToken(oldRefresh));
  auditConsole(c, user, 'mail:connect', { canSend: grant.scopes.includes(GMAIL_SEND_SCOPE) });
}

/**
 * A grant that could not be stored ends as ConnectStop. Its fresh token is revoked, unless the stored row is an ACTIVE
 * token of the same Google account: Google's revoke would end that working connection too. An invalid same-account
 * row's token is already dead. `stored` undefined = unknown.
 */
function failedGrant(e: unknown, grant: IssuedGrant, stored: MailCredentialRow | null | undefined): ConnectStop {
  if (!(e instanceof ConnectStop)) logConnectFailure(e);
  const result = e instanceof ConnectStop ? e.result : 'failed';
  const keep = stored?.status === 'active' && grant.identity && holdsSameAccount(stored, grant.identity);
  return new ConnectStop(result, keep ? undefined : (grant.tokens.refreshToken ?? grant.tokens.accessToken));
}

/** Accepts and stores what Google issued; every failure (D1 and decrypt errors too) goes through failedGrant. */
async function connectGrant(c: Context<AppEnv>, user: UserRow, grant: IssuedGrant): Promise<void> {
  let stored: MailCredentialRow | null | undefined;
  try {
    stored = await (await getRuntime(c.env)).store.getMailCredential(user.id);
    await storeConnection(c, user, await acceptGrant(c.env, user, grant), stored);
  } catch (e) {
    throw failedGrant(e, grant, stored);
  }
}

/** The callback's steps; any failure ends as a result code (Google's error text never reaches the redirect). */
async function finishConnect(c: Context<AppEnv>): Promise<ConnectResult> {
  const user = await optionalSessionUser(c);
  if (!user) return 'session';
  const pending = await takePending(c, user);
  const error = c.req.query('error');
  if (error) return error === 'access_denied' ? 'denied' : 'failed';
  if (!pending) return 'expired';
  const google = googleClientOf(c.env);
  const code = c.req.query('code');
  if (!google || !code) return 'failed';
  const tokens = await exchangeCode(c.env, google, code, pending.verifier);
  await connectGrant(c, user, { tokens, identity: verifiedIdentity(tokens.idToken, google, pending.nonce) });
  return 'connected';
}

function logConnectFailure(e: unknown): void {
  if (!(e instanceof WmmError)) console.error('mail connect failed:', e instanceof Error ? e.name : 'unknown');
}

/**
 * Revokes the user's stored refresh token at Google before its row goes (disconnect, account deletion). Never throws:
 * the row is deleted anyway when Google cannot be asked (the user asked for it); the token then lives on at Google,
 * known to nobody, and a warning names the failure.
 */
export async function revokeStoredMail(env: Env, userId: number): Promise<void> {
  try {
    const rt = await getRuntime(env);
    const row = await rt.store.getMailCredential(userId);
    if (!row?.refreshEnc) return;
    const revoked = await revokeGoogleToken(await rt.key.decrypt(row.refreshEnc));
    if (!revoked) console.warn('mail revoke failed: Google not reachable');
  } catch (e) {
    console.warn('mail revoke failed:', e instanceof Error ? e.name : 'unknown');
  }
}

type EndReason = 'idle' | 'revoked' | null;

function endReasonOf(row: MailCredentialRow): EndReason {
  if (row.status === 'active') return null;
  return row.refreshEnc === null ? 'idle' : 'revoked';
}

/** `mail` of GET /api/me: null when mail is not configured. Never carries lastError (the console localises). */
export async function mailInfo(env: Env, store: D1Store, user: UserRow) {
  if (!googleClientOf(env)) return null;
  const limit = mailSlotsOf(env);
  const [row, hasSlot, taken] = await Promise.all([
    store.getMailCredential(user.id),
    store.hasMailSlot(user.moodleUserId),
    limit === null ? Promise.resolve(0) : store.countMailSlots(),
  ]);
  const connection = row && {
    address: row.address,
    canSend: row.scopes.includes(GMAIL_SEND_SCOPE),
    status: row.status,
    connectedAt: row.connectedAt,
    lastUsedAt: row.lastUsedAt,
    endReason: endReasonOf(row),
  };
  return {
    connection,
    slotsLeft: limit === null ? null : Math.max(0, limit - taken),
    hasSlot,
    idleDays: mailIdleDaysOf(env),
  };
}

export function mailRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/api/mail/connect', session, async (c) => {
    const google = googleClientOf(c.env);
    if (!google) throw new NotFound('Mail is not available.');
    const user = c.get('user');
    memoryRateLimit(`mail:connect:${user.id}`, 20, 10 * 60_000);
    const rt = await getRuntime(c.env);
    if (!(await slotAvailable(c.env, rt.store, user.moodleUserId))) throw new Forbidden(SLOTS_FULL);
    return c.json({ url: await startConnect(c, google, user) });
  });

  app.get('/api/google/callback', async (c) => {
    const result = await finishConnect(c).catch((e: unknown) => {
      if (e instanceof ConnectStop) {
        if (e.revoke) deferOn(c, revokeGoogleToken(e.revoke));
        return e.result;
      }
      logConnectFailure(e);
      return 'failed' as const;
    });
    c.header('Set-Cookie', hostCookie(STATE_COOKIE, '', 0));
    return c.redirect(`${publicUrlOf(c.env)}/settings/mail?mail=${result}`, 302);
  });

  app.delete('/api/mail', session, async (c) => {
    const user = c.get('user');
    await revokeStoredMail(c.env, user.id);
    const rt = await getRuntime(c.env);
    if (await rt.store.deleteMailCredential(user.id)) auditConsole(c, user, 'mail:disconnect', {});
    return c.json({ ok: true });
  });

  return app;
}
