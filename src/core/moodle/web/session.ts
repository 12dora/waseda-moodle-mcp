/**
 * The web session transport (WebSession): one user's MoodleSession cookie + sesskey against MOODLE_URL.
 * Ajax calls of one tick share one /lib/ajax/service.php POST; pages are fetched without automatic redirects (each
 * hop is checked: the cookie only ever goes to baseUrl) and memoised by path. Never logs cookies, sesskeys or bodies.
 */

import { InvalidInput, MoodleError, MoodleUnavailable, NeedsReconnect, WmmError } from '../../errors';
import { isWriteCall, trackWrite } from '../client';
import { MOODLE_URL } from '../launch';
import { sessionCookie } from '../wire';
import { batches, batchFailure, type Pending, settle } from './ajax-batch';
import { pageConfig } from './html';
import { pageError } from './page-errors';
import type { WebPage, WebRequest, WebSession } from './types';

export interface MoodleWebSessionOptions {
  /** 'MoodleSession=<value>' (see normalizeSessionCookie). */
  cookie: string;
  sesskey?: string | null;
  moodleUserId: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Called before every HTTP request (the client's budget); throws BudgetExceeded. */
  charge: () => void;
  timeoutMs?: number; // default 25_000 per request (headers and body)
  /** Moodle rotated the cookie, or a (new) sesskey was read: store it. Best effort. */
  onUpdate?: (update: { cookie?: string; sesskey?: string }) => void | Promise<void>;
  /** Moodle sent the request to its login page: the session is over. Called once. */
  onEnded?: () => void | Promise<void>;
}

const ENDED_MSG = 'The Moodle session has ended. Reconnect to continue.';
const MAX_HOPS = 3;
const LOGIN_PATHS = new Set(['/login/index.php', '/auth/saml2/login.php']);
const LOGIN_BODY = /<body\s+id="page-login-index"/;
/** Request-level codes that mean the session is over. */
const ENDED_CODES = new Set(['servicerequireslogin', 'requireloginerror']);

interface Answer {
  status: number;
  /** Absolute Location of a 3xx answer, null otherwise. */
  location: string | null;
  body: string;
  /** A rotated session cookie (Set-Cookie); stored only once the answer passed the checks. */
  cookie: string | null;
}

const discard = (res: Response) => {
  res.body?.cancel().catch(() => {});
};

const best = (f: () => unknown) => {
  try {
    Promise.resolve(f()).catch(() => {});
  } catch {
    /* best effort */
  }
};

export class MoodleWebSession implements WebSession {
  readonly baseUrl: string;
  readonly moodleUserId: number;
  private cookie: string;
  private key: string | null;
  private keyRead: Promise<string> | null = null;
  private ended = false;
  private writes = 0;
  private readonly origin: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly opts: MoodleWebSessionOptions;
  private readonly pages = new Map<string, Promise<WebPage>>();
  private queue: Pending[] = [];

  constructor(opts: MoodleWebSessionOptions) {
    this.opts = opts;
    this.cookie = opts.cookie;
    this.key = opts.sesskey || null;
    this.moodleUserId = opts.moodleUserId;
    this.baseUrl = (opts.baseUrl ?? MOODLE_URL).replace(/\/+$/, '');
    this.origin = new URL(this.baseUrl).origin;
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 25_000;
  }

  /** Requests that may have changed Moodle (see MoodleApi.writesSent). */
  get writesSent(): number {
    return this.writes;
  }

  // ------------------------------------------------------------------ transport

  /**
   * One request with the cookie to a baseUrl URL: charged, never following redirects, `read` under the deadline.
   * Network failures, timeouts and 5xx -> MoodleUnavailable. A rotated cookie is not taken from here: the caller
   * stores it once the answer passed its checks (a dead session's answer carries a visitor cookie).
   */
  private async exchange<T>(
    url: string,
    init: RequestInit,
    read: (res: Response) => Promise<T>,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    if (this.ended) throw new NeedsReconnect(ENDED_MSG);
    if (new URL(url).origin !== this.origin) throw new InvalidInput('Only Waseda Moodle pages can be fetched.');
    this.opts.charge();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers = { ...(init.headers as Record<string, string> | undefined), Cookie: this.cookie };
      const res = await this.doFetch(url, { ...init, headers, redirect: 'manual', signal: ac.signal });
      if (res.status >= 500) {
        discard(res);
        throw new MoodleUnavailable();
      }
      return await read(res);
    } catch (e) {
      throw e instanceof WmmError ? e : new MoodleUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The raw answer (headers within the deadline, body streamed) of one request with the cookie: file downloads and
   * uploads. `url` must be on baseUrl. Redirects are not followed (check them with checkLocation). The deadline
   * (default: the session's) runs until the response headers. Store a rotated cookie with acceptCookie once the
   * answer is known to be good.
   */
  send(url: string, init: RequestInit & { duplex?: 'half' }, timeoutMs?: number): Promise<Response> {
    return this.exchange(url, init, async (res) => res, timeoutMs);
  }

  private async answer(url: string, init: RequestInit): Promise<Answer> {
    return this.exchange(url, init, async (res) => {
      const raw = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      const cookie = sessionCookie(res);
      if (raw === null) return { status: res.status, location: null, body: await res.text(), cookie };
      discard(res);
      return { status: res.status, location: this.absolute(raw), body: '', cookie };
    });
  }

  private absolute(location: string): string {
    try {
      return new URL(location, `${this.baseUrl}/`).toString();
    } catch {
      throw new MoodleUnavailable('Moodle redirected the request unexpectedly.');
    }
  }

  private noteCookie(fresh: string | null): void {
    if (!fresh || fresh === this.cookie) return;
    this.cookie = fresh;
    best(() => this.opts.onUpdate?.({ cookie: fresh }));
  }

  /** Stores the cookie a good answer of `send` rotated (not for login redirects, error answers or 5xx). */
  acceptCookie(res: Response): void {
    this.noteCookie(sessionCookie(res));
  }

  /** Runs one request that may change Moodle, counted in writesSent unless Moodle refused the session. */
  sending<T>(run: () => Promise<T>): Promise<T> {
    return trackWrite(run, () => this.writes++);
  }

  private noteSesskey(key: string | null): void {
    if (!key || key === this.key) return;
    this.key = key;
    best(() => this.opts.onUpdate?.({ sesskey: key }));
  }

  /** The session is over: tells the owner once; every later request fails without network use. */
  private end(): NeedsReconnect {
    if (!this.ended) {
      this.ended = true;
      best(() => this.opts.onEnded?.());
    }
    return new NeedsReconnect(ENDED_MSG);
  }

  /** Throws NeedsReconnect when an answer says the session is over (an ended-session error code or the login page). */
  checkSignedIn(body: string, code = ''): void {
    if (ENDED_CODES.has(code) || LOGIN_BODY.test(body)) throw this.end();
  }

  /** Throws NeedsReconnect when a redirect target is Moodle's login page or the single sign-on. */
  checkLocation(location: string): void {
    const u = new URL(this.absolute(location));
    // a signed-out session is always sent to Moodle's own login page first (measured), never straight to the IdP
    const login = u.origin === this.origin && LOGIN_PATHS.has(u.pathname);
    if (login) throw this.end();
  }

  /** Throws for the login page and Moodle error pages; otherwise picks up the page's sesskey. */
  private checkBody(html: string, status: number): void {
    this.checkSignedIn(html);
    const error = pageError(html);
    if (error) throw error;
    if (status === 404) throw new MoodleError('Moodle could not find that page.', 'invalidrecord');
    if (status === 403) throw new MoodleError('Moodle refused access to that page.', 'nopermissions');
    if (status >= 400) throw new MoodleError('Moodle refused the request.', 'moodle_error');
    this.noteSesskey(pageConfig(html).sesskey);
  }

  // ------------------------------------------------------------------ pages

  /** A path relative to baseUrl ('/…'); absolute baseUrl URLs are reduced to theirs. */
  private relative(path: string): string {
    if (path.startsWith('/') && !path.startsWith('//')) return path;
    const u = URL.canParse(path) ? new URL(path) : null;
    if (!u || u.origin !== this.origin) throw new InvalidInput('Only Waseda Moodle pages can be fetched.');
    return `${u.pathname}${u.search}`;
  }

  async page(path: string, req: WebRequest = {}): Promise<WebPage> {
    const target = this.relative(path);
    if (req.method === 'POST') {
      this.pages.clear();
      return this.post(target, req.form ?? new URLSearchParams());
    }
    if (req.follow === false) return this.get(target, false);
    const hit = this.pages.get(target);
    if (hit) return hit;
    const p = this.get(target, true);
    this.pages.set(target, p);
    p.catch(() => this.pages.delete(target));
    return p;
  }

  /** Drops the memoised pages (after a write). */
  forgetPages(): void {
    this.pages.clear();
  }

  /** The first page already fetched in this session (memo) whose HTML matches `pattern`; null = none. */
  async seenPage(pattern: RegExp): Promise<WebPage | null> {
    for (const p of [...this.pages.values()]) {
      const page = await p.catch(() => null);
      if (page && pattern.test(page.html)) return page;
    }
    return null;
  }

  private async get(path: string, follow: boolean): Promise<WebPage> {
    let url = `${this.baseUrl}${path}`;
    for (let hop = 0; ; hop++) {
      const a = await this.answer(url, { method: 'GET' });
      if (a.location === null) {
        this.checkBody(a.body, a.status);
        this.noteCookie(a.cookie);
        return { url, status: a.status, html: a.body, location: null };
      }
      this.checkLocation(a.location);
      this.noteCookie(a.cookie);
      const local = new URL(a.location).origin === this.origin;
      if (!follow || !local) return { url, status: a.status, html: '', location: a.location };
      if (hop >= MAX_HOPS) throw new MoodleUnavailable('Moodle redirected the request too many times.');
      url = a.location;
    }
  }

  /** A form POST may write: counted in writesSent (unless the login check refused it). */
  private post(path: string, form: URLSearchParams): Promise<WebPage> {
    const url = `${this.baseUrl}${path}`;
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    };
    return this.sending(async () => {
      const a = await this.answer(url, init);
      if (a.location !== null) this.checkLocation(a.location);
      else this.checkBody(a.body, a.status);
      this.noteCookie(a.cookie);
      return { url, status: a.status, html: a.body, location: a.location };
    });
  }

  // ------------------------------------------------------------------ sesskey

  sesskey(): Promise<string> {
    if (this.key) return Promise.resolve(this.key);
    this.keyRead ??= this.readSesskey().finally(() => {
      this.keyRead = null;
    });
    return this.keyRead;
  }

  /** Moodle refused the cached sesskey: reads the current one (concurrent callers share the read). */
  async renewSesskey(): Promise<string> {
    if (!this.keyRead) this.key = null;
    return this.sesskey();
  }

  /** Any light page carries M.cfg.sesskey (checkBody records it). */
  private async readSesskey(): Promise<string> {
    const path = '/user/preferences.php';
    this.pages.delete(path);
    await this.page(path);
    if (!this.key) throw new MoodleUnavailable('Moodle did not provide a session key.');
    return this.key;
  }

  // ------------------------------------------------------------------ ajax

  ajax<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.queue.length === 0) queueMicrotask(() => this.flush());
      this.queue.push({ fn, args, resolve, reject });
    }) as Promise<T>;
  }

  private flush(): void {
    const pending = this.queue;
    this.queue = [];
    for (const batch of batches(pending)) void this.sendBatch(batch);
  }

  private async sendBatch(batch: Pending[]): Promise<void> {
    const run = () => this.postBatch(batch, true);
    try {
      const answers = await (batch.some((p) => isWriteCall(p.fn, p.args)) ? this.sending(run) : run());
      for (const [i, p] of batch.entries()) settle(p, answers[i]);
    } catch (e) {
      for (const p of batch) p.reject(e);
    }
  }

  private async postBatch(batch: Pending[], retry: boolean): Promise<unknown[]> {
    const key = await this.sesskey();
    const info = batch.length === 1 ? (batch[0]?.fn ?? '') : `${batch.length}_calls`;
    const url = `${this.baseUrl}/lib/ajax/service.php?${new URLSearchParams({ sesskey: key, info })}`;
    const body = JSON.stringify(batch.map((p, index) => ({ index, methodname: p.fn, args: p.args })));
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body };
    const a = await this.answer(url, init);
    if (a.location !== null) {
      this.checkLocation(a.location);
      throw new MoodleUnavailable();
    }
    const parsed = this.parseAjax(a.body);
    const failure = batchFailure(parsed);
    if (!failure) {
      this.noteCookie(a.cookie);
      return parsed as unknown[];
    }
    if (failure.code === 'invalidsesskey' && retry) {
      await this.renewSesskey();
      return this.postBatch(batch, false);
    }
    this.checkSignedIn('', failure.code);
    if (failure.code === 'unavailable') throw new MoodleUnavailable();
    throw new MoodleError(failure.message || 'Moodle returned an error.', failure.code);
  }

  private parseAjax(body: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      this.checkSignedIn(body);
      throw new MoodleUnavailable();
    }
  }
}
