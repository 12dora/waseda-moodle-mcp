/**
 * Moodle REST + file client. Runtime-agnostic (fetch + streams only).
 * The token only ever travels in POST bodies, except for pluginfile downloads (`token=` query, required by Moodle).
 */

import type { DraftUploadResult, MoodleApi } from '../context';
import { BudgetExceeded, InvalidInput, MoodleError, MoodleUnavailable, NeedsReconnect } from '../errors';
import { MOODLE_URL } from './launch';
import {
  fileDownloadUrl,
  isObj,
  isTokenGone,
  type Json,
  looksLikeSmallJson,
  multipartParts,
  peekJson,
  readEnvelope,
  sanitizeFilename,
  type UploadFile,
  uploadBody,
  uploadError,
} from './wire';

export interface MoodleClientOptions {
  token: string;
  moodleUserId: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxCalls?: number; // default 40
  timeoutMs?: number; // default 25_000 per REST call / until response headers
  uploadTimeoutMs?: number; // default 120_000
  onTokenInvalid?: () => Promise<void>;
  onSuccess?: () => void;
}

function scalarParam(v: unknown): string | null {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return null;
}

function childEntries(v: unknown): Array<[string, unknown]> {
  if (Array.isArray(v)) return v.map((x, i): [string, unknown] => [String(i), x]);
  if (typeof v === 'object' && v !== null) return Object.entries(v);
  return [];
}

function appendParam(out: URLSearchParams, key: string, v: unknown): void {
  const scalar = scalarParam(v);
  if (scalar !== null) {
    out.append(key, scalar);
    return;
  }
  for (const [k, x] of childEntries(v)) appendParam(out, `${key}[${k}]`, x);
}

/** PHP array encoding: `a[0]=x`, `a[b][c]=y`; booleans -> 0/1; null/undefined are skipped. */
export function encodeParams(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) appendParam(out, k, v);
  return out;
}

/** Functions that change state (or allocate ids) are never memoised and never retried. */
const WRITE_FN =
  /save|submit|add|send|update|create|delete|view_|mark|unused|start_|finish|process|remove|reset|toggle/;
const isReadFunction = (fn: string) => !WRITE_FN.test(fn);

const RESERVED = new Set(['wstoken', 'wsfunction', 'moodlewsrestformat']);
const isReserved = (key: string) => RESERVED.has(key.split('[')[0] ?? key);
const isRedirect = (res: Response) => (res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect';
const REDIRECT_MSG = 'Moodle redirected the download unexpectedly.';
const MAX_HOPS = 3;

const discard = (res: Response) => {
  res.body?.cancel().catch(() => {});
};

export class MoodleClient implements MoodleApi {
  readonly baseUrl: string;
  readonly moodleUserId: number;
  private calls = 0;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly maxCalls: number;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly onTokenInvalid?: () => Promise<void>;
  private readonly onSuccess?: () => void;
  private readonly memo = new Map<string, Promise<unknown>>();
  private invalid = false;
  private succeeded = false;

  constructor(opts: MoodleClientOptions) {
    this.token = opts.token;
    this.moodleUserId = opts.moodleUserId;
    this.baseUrl = (opts.baseUrl ?? MOODLE_URL).replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxCalls = opts.maxCalls ?? 40;
    this.timeoutMs = opts.timeoutMs ?? 25_000;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? 120_000;
    this.onTokenInvalid = opts.onTokenInvalid;
    this.onSuccess = opts.onSuccess;
  }

  get callsMade(): number {
    return this.calls;
  }

  // ------------------------------------------------------------------ REST

  call<T = unknown>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.invalid) return Promise.reject(new NeedsReconnect());
    if (!isReadFunction(fn)) {
      this.memo.clear();
      return this.exec<T>(fn, params, false).finally(() => this.memo.clear());
    }
    const key = `${fn}?${encodeParams(params).toString()}`;
    const hit = this.memo.get(key);
    if (hit) return hit as Promise<T>;
    const p = this.exec<T>(fn, params, true);
    this.memo.set(key, p);
    p.catch(() => this.memo.delete(key));
    return p;
  }

  private async exec<T>(fn: string, params: Record<string, unknown>, read: boolean): Promise<T> {
    try {
      return (await this.restOnce(fn, params)) as T;
    } catch (e) {
      if (!(read && e instanceof MoodleUnavailable)) throw e;
      return (await this.restOnce(fn, params)) as T;
    }
  }

  private spend(): void {
    if (this.calls >= this.maxCalls) throw new BudgetExceeded();
    this.calls++;
  }

  private async restOnce(fn: string, params: Record<string, unknown>): Promise<unknown> {
    this.spend();
    const body = new URLSearchParams({ wstoken: this.token, wsfunction: fn, moodlewsrestformat: 'json' });
    for (const [k, v] of encodeParams(params)) {
      if (!isReserved(k)) body.append(k, v);
    }
    const parsed = parseJson(await this.postRest(body));
    if (isObj(parsed)) await this.checkEnvelope(parsed);
    this.markOk();
    return parsed;
  }

  /** POSTs the form body and returns the response text (5xx, redirects, network failures -> MoodleUnavailable). */
  private async postRest(body: URLSearchParams): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(`${this.baseUrl}/webservice/rest/server.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        redirect: 'manual', // the token is in the body: never follow a redirect with it
        signal: ac.signal,
      });
      if (isRedirect(res) || res.status >= 500) throw new MoodleUnavailable();
      return await res.text();
    } catch {
      throw new MoodleUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  private markOk(): void {
    if (this.succeeded) return;
    this.succeeded = true;
    try {
      this.onSuccess?.();
    } catch {
      /* best effort */
    }
  }

  private async markInvalid(): Promise<void> {
    if (this.invalid) return;
    this.invalid = true;
    try {
      await this.onTokenInvalid?.();
    } catch {
      /* best effort */
    }
  }

  /** Throws for a Moodle error object; returns for ordinary data. */
  private async checkEnvelope(o: Json): Promise<void> {
    const env = readEnvelope(o);
    if (!env) return;
    if (isTokenGone(env)) {
      await this.markInvalid();
      throw new NeedsReconnect();
    }
    throw new MoodleError(env.message || 'Moodle returned an error.', env.code || 'moodle_error', env.exception);
  }

  // ------------------------------------------------------------------ files

  private fileTarget(fileUrl: string): string {
    return fileDownloadUrl({ baseUrl: this.baseUrl, token: this.token }, fileUrl);
  }

  private async send(url: string, init: RequestInit & { duplex?: 'half' }, timeoutMs: number): Promise<Response> {
    this.spend();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await this.doFetch(url, { ...init, signal: ac.signal });
    } catch {
      throw new MoodleUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Re-validates a redirect target: the token must never be sent anywhere we did not check. */
  private redirectTarget(location: string, from: string, hop: number): string {
    if (hop >= MAX_HOPS) throw new MoodleUnavailable(REDIRECT_MSG);
    try {
      return this.fileTarget(new URL(location, from).toString());
    } catch {
      throw new MoodleUnavailable(REDIRECT_MSG);
    }
  }

  private async getFollowing(fileUrl: string, init: { method?: 'GET' | 'HEAD'; range?: string }): Promise<Response> {
    const headers: Record<string, string> = init.range ? { Range: init.range } : {};
    let target = this.fileTarget(fileUrl);
    for (let hop = 0; ; hop++) {
      const req = { method: init.method ?? 'GET', headers, redirect: 'manual' } as const;
      const res = await this.send(target, req, this.timeoutMs);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) return res;
      discard(res);
      target = this.redirectTarget(location, target, hop);
    }
  }

  async fetchFile(fileUrl: string, init: { method?: 'GET' | 'HEAD'; range?: string } = {}): Promise<Response> {
    if (this.invalid) throw new NeedsReconnect();
    const res = await this.getFollowing(fileUrl, init);
    if (res.status >= 500) {
      discard(res);
      throw new MoodleUnavailable();
    }
    // Moodle answers a bad token with HTTP 200 and a small JSON error object (often without Content-Length).
    if (init.method !== 'HEAD' && looksLikeSmallJson(res)) {
      const parsed = await peekJson(res);
      if (isObj(parsed)) await this.checkEnvelope(parsed);
    }
    this.markOk();
    return res;
  }

  async uploadToDraft(file: UploadFile, itemId: number): Promise<DraftUploadResult> {
    if (this.invalid) throw new NeedsReconnect();
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new InvalidInput('The file size is invalid.');
    const name = sanitizeFilename(file.name);
    if (!name) throw new InvalidInput('The file needs a name.');
    const mime = (file.mime ?? '').replace(/[\r\n;]+/g, '') || 'application/octet-stream';
    const parts = multipartParts({ token: this.token, itemId, name, mime });
    const { body, duplex } = await uploadBody(file, parts);

    const res = await this.send(
      `${this.baseUrl}/webservice/upload.php`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${parts.boundary}` },
        body,
        duplex,
        redirect: 'manual',
      },
      this.uploadTimeoutMs,
    );
    if (isRedirect(res)) throw new MoodleUnavailable();
    const result = await this.readUpload(res, file);
    this.markOk();
    return result;
  }

  private async readUpload(res: Response, file: UploadFile): Promise<DraftUploadResult> {
    if (res.status === 413) throw new MoodleError('The file is too large for Moodle.', 'fileoversized');
    if (res.status >= 500) throw new MoodleUnavailable();
    const parsed = parseJson(await res.text());
    const rec = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!isObj(rec)) throw new MoodleError('Unexpected response from the Moodle upload endpoint.', 'upload_failed');
    await this.checkEnvelope(rec);
    const failure = uploadError(rec);
    if (failure) throw failure;
    const id = Number(rec.itemid);
    if (!Number.isFinite(id) || id <= 0) {
      throw new MoodleError('Unexpected response from the Moodle upload endpoint.', 'upload_failed');
    }
    return {
      itemid: id,
      filename: typeof rec.filename === 'string' ? rec.filename : file.name,
      filesize: Number(rec.filesize) || file.size,
    };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MoodleUnavailable();
  }
}
