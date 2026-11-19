/**
 * Gmail REST client of one stored Waseda mail connection (MailApi). Access tokens come from the refresh token and are
 * cached per isolate until shortly before they expire. Every subrequest (token refresh included) counts against the
 * client's call limit and the invocation's shared budget.
 */

import type { InvocationBudget } from '../budget';
import type { MailApi, MailQuery } from '../context';
import { sha256Hex } from '../crypto';
import {
  BudgetExceeded,
  Forbidden,
  InvalidInput,
  MailNeedsReconnect,
  MailUnavailable,
  NotFound,
  RateLimited,
} from '../errors';
import { mailReconnect } from './connection';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/';
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const TIMEOUT_MS = 25_000;
/** A cached access token is no longer handed out this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;
const TOKEN_CACHE_MAX = 200;
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
const TOO_MANY_CALLS = 'Too many mail requests in one call. Narrow the request.';
const SCOPE_MISSING = 'This mail connection does not allow that. Reconnect mail in the console and allow it.';
/** Anything shaped like an e-mail address (Google's error text may echo a recipient). */
const ADDRESS_RE = /[^\s<>()[\]"',;:@]+@[^\s<>()[\]"',;:@]+/g;

interface GmailClientOptions {
  address: string;
  scopes: readonly string[];
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  /** Subrequests this client may make (default 40). */
  maxCalls?: number;
  /** The invocation's shared budget: each subrequest is charged to it too. */
  budget?: InvocationBudget;
  /** Google rejected the refresh token (invalid_grant): mark the stored connection invalid. */
  onInvalid?: () => Promise<unknown>;
  /** The first Gmail call of this client succeeded. */
  onUsed?: () => void;
}

/** Access tokens per isolate, keyed by sha256 of the refresh token (Map order = insertion: the first is the oldest). */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

function cacheAccessToken(key: string, token: string, expiresInSec: number): void {
  accessTokens.delete(key);
  if (accessTokens.size >= TOKEN_CACHE_MAX) {
    const oldest = accessTokens.keys().next();
    if (!oldest.done) accessTokens.delete(oldest.value);
  }
  accessTokens.set(key, { token, expiresAt: Date.now() + expiresInSec * 1000 });
}

function cachedAccessToken(key: string): string | null {
  const hit = accessTokens.get(key);
  return hit && hit.expiresAt - EXPIRY_MARGIN_MS > Date.now() ? hit.token : null;
}

/** A successful Gmail answer as JSON; empty or unreadable counts as Gmail misbehaving (no silent {}). */
function json<T>(text: string): T {
  if (!text) throw new MailUnavailable();
  const parsed = parseJson(text);
  if (parsed === null) throw new MailUnavailable();
  return parsed as T;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Gmail URL: path segments encoded one by one (no dot segments), query arrays repeat their key. */
function gmailUrl(path: string, query: MailQuery = {}): string {
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new InvalidInput('Invalid mail id.');
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) params.append(k, String(item));
  }
  const qs = params.toString();
  return `${GMAIL_URL}${segments.map(encodeURIComponent).join('/')}${qs ? `?${qs}` : ''}`;
}

interface GoogleError {
  message: string;
  reasons: string[];
}

/** Google's error text reaches the tool result and the audit log: no address of anyone may stay in it. */
const withoutAddresses = (text: string): string => text.replace(ADDRESS_RE, '<address>');

function googleError(body: unknown): GoogleError {
  const err = isObj(body) && isObj(body.error) ? body.error : {};
  const reasons: string[] = [];
  for (const list of [err.errors, err.details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) if (isObj(item) && typeof item.reason === 'string') reasons.push(item.reason);
  }
  const message = typeof err.message === 'string' ? withoutAddresses(err.message.trim()).slice(0, 200) : '';
  return { message, reasons };
}

/** Maps a failed Gmail answer (not 401, which the client handles) to a user-safe error. */
function gmailFailure(status: number, body: unknown): Error {
  if (status >= 500 || status < 400) return new MailUnavailable(); // 5xx, or a redirect (never followed)
  if (status === 429) return new RateLimited();
  if (status === 404) return new NotFound('Mail not found.');
  const { message, reasons } = googleError(body);
  if (status === 403) {
    const scope = reasons.includes('insufficientPermissions') || reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT');
    return new Forbidden(scope || !message ? SCOPE_MISSING : message);
  }
  return new InvalidInput(message || 'Gmail rejected the request.');
}

/** Gmail answered 401 to the access token `used`. */
class Unauthorized extends Error {
  constructor(readonly used: Promise<string>) {
    super('unauthorized');
  }
}

export class GmailClient implements MailApi {
  readonly address: string;
  readonly canSend: boolean;
  private calls = 0;
  private used = false;
  private readonly opts: GmailClientOptions;
  private readonly doFetch: typeof fetch;
  private readonly maxCalls: number;
  /** The access token this client uses (refreshed at most once per 401). */
  private token: Promise<string> | null = null;

  constructor(opts: GmailClientOptions) {
    this.opts = opts;
    this.address = opts.address;
    this.canSend = opts.scopes.includes(GMAIL_SEND_SCOPE);
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxCalls = opts.maxCalls ?? 40;
  }

  get callsMade(): number {
    return this.calls;
  }

  async get<T = unknown>(path: string, query?: MailQuery): Promise<T> {
    return json<T>(await this.getText(path, query));
  }

  async getText(path: string, query?: MailQuery): Promise<string> {
    const url = gmailUrl(path, query);
    try {
      return await this.request('GET', url);
    } catch (e) {
      if (!(e instanceof MailUnavailable)) throw e;
      return this.request('GET', url);
    }
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return json<T>(await this.request('POST', gmailUrl(path), JSON.stringify(body)));
  }

  private spend(): void {
    if (this.calls >= this.maxCalls) throw new BudgetExceeded(TOO_MANY_CALLS);
    this.opts.budget?.spendMoodle();
    this.calls++;
  }

  /** A failure on the way (network, timeout) is MailUnavailable; `maybeSent` false for the token endpoint. */
  private async fetchOnce(url: string, init: RequestInit, maybeSent = true): Promise<Response> {
    this.spend();
    try {
      return await this.doFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new MailUnavailable(undefined, { maybeSent });
    }
  }

  /** One Gmail call (its body text); a 401 drops the access token and repeats the call once with a fresh one. */
  private async request(method: 'GET' | 'POST', url: string, body?: string): Promise<string> {
    let res: Response;
    try {
      res = await this.send(method, url, body);
    } catch (e) {
      if (!(e instanceof Unauthorized)) throw e;
      // concurrent calls that hit the same stale token share one refresh
      if (this.token === e.used) this.token = this.refresh();
      res = await this.send(method, url, body).catch((again: unknown) => {
        throw again instanceof Unauthorized ? mailReconnect() : again;
      });
    }
    const text = await res.text().catch(() => null);
    if (!res.ok) throw gmailFailure(res.status, parseJson(text ?? ''));
    this.markUsed();
    if (text === null) throw new MailUnavailable();
    return text;
  }

  private async send(method: 'GET' | 'POST', url: string, body?: string): Promise<Response> {
    this.token ??= this.accessToken();
    const used = this.token;
    const token = await this.tokenOf(used);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchOnce(url, { method, headers, body });
    if (res.status === 401) {
      await res.body?.cancel();
      throw new Unauthorized(used);
    }
    return res;
  }

  /** Awaits an access token; a failed refresh is forgotten (tried again next call) unless the connection is dead. */
  private async tokenOf(pending: Promise<string>): Promise<string> {
    try {
      return await pending;
    } catch (e) {
      if (!(e instanceof MailNeedsReconnect) && this.token === pending) this.token = null;
      throw e;
    }
  }

  private markUsed(): void {
    if (this.used) return;
    this.used = true;
    try {
      this.opts.onUsed?.();
    } catch {
      /* best effort */
    }
  }

  private async accessToken(): Promise<string> {
    return cachedAccessToken(await sha256Hex(this.opts.refreshToken)) ?? this.refresh();
  }

  /** Exchanges the refresh token for a new access token (and caches it). Its failures mean nothing reached Gmail. */
  private async refresh(): Promise<string> {
    const key = await sha256Hex(this.opts.refreshToken);
    accessTokens.delete(key);
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.opts.refreshToken,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    const init = { method: 'POST', headers: FORM, body: form.toString() };
    const res = await this.fetchOnce(GOOGLE_TOKEN_URL, init, false);
    const json = parseJson(await res.text().catch(() => ''));
    if (res.ok && isObj(json) && typeof json.access_token === 'string') {
      const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
      cacheAccessToken(key, json.access_token, expiresIn);
      return json.access_token;
    }
    if ((res.status === 400 || res.status === 401) && isObj(json) && json.error === 'invalid_grant') {
      await this.opts.onInvalid?.().catch(() => undefined);
      throw mailReconnect();
    }
    throw res.status === 429 ? new RateLimited() : new MailUnavailable(undefined, { maybeSent: false });
  }
}

/** Revokes a Google token (refresh or access) at Google. Best effort: false when Google could not be asked. */
export async function revokeGoogleToken(
  token: string,
  doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<boolean> {
  try {
    const res = await doFetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.ok || res.status === 400; // 400 invalid_token: already revoked
  } catch {
    return false;
  }
}
