/**
 * Fetch wrapper for the console API: same-origin cookies, `X-WMM: 1` on state-changing requests,
 * `{error:{code,message}}` → ApiError, 401 → /connect?return=… (unless the caller opts out).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Full JSON error body, for endpoints that attach extra fields (e.g. `account` on account_switch). */
  readonly body: unknown;
  constructor(status: number, code: string, message: string, body: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

type UnauthorizedHandler = (returnTo: string) => void;
let onUnauthorized: UnauthorizedHandler | null = null;
/** 'paused' = usage-guard block (contract §13); 'challenge' = a Cloudflare challenge page instead of the API. */
export type EdgeBlock = 'paused' | 'challenge';
let onPaused: ((kind: EdgeBlock) => void) | null = null;

/** Registered by the app shell: called when /api/* is blocked at the edge. */
export function setPausedHandler(fn: ((kind: EdgeBlock) => void) | null): void {
  onPaused = fn;
}

/** Cloudflare edge block: 403 with `cf-mitigated`, or an HTML block page instead of JSON. */
function edgeBlock(res: Response): EdgeBlock | null {
  if (res.status !== 403) return null;
  const mitigated = res.headers.get('cf-mitigated');
  if (mitigated === 'challenge') return 'challenge';
  if (mitigated !== null || (res.headers.get('content-type') ?? '').includes('text/html')) return 'paused';
  return null;
}

/** Registered by the router so redirects stay inside the SPA. */
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  onUnauthorized = fn;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  /** Default true. Set false where a 401 is an expected answer (connect / consent pages). */
  redirectOn401?: boolean;
}

type CallOptions = Omit<RequestOptions, 'method' | 'body'>;

function buildPath(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

function buildInit(method: NonNullable<RequestOptions['method']>, body: unknown): RequestInit {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-WMM'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readError(status: number, payload: unknown): ApiError {
  const err = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (!err || typeof err !== 'object') return new ApiError(status, 'http_error', `HTTP ${status}`, payload);
  const code = typeof err.code === 'string' ? err.code : 'error';
  const message = typeof err.message === 'string' ? err.message : `HTTP ${status}`;
  return new ApiError(status, code, message, payload);
}

function redirectToConnect(): void {
  const returnTo = location.pathname + location.search;
  if (onUnauthorized) onUnauthorized(returnTo);
  else location.assign(`/connect?return=${encodeURIComponent(returnTo)}`);
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', 'Network error');
  }
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(buildPath(path, opts.query), buildInit(opts.method ?? 'GET', opts.body));
  const blocked = edgeBlock(res);
  if (blocked) {
    onPaused?.(blocked);
    throw new ApiError(403, blocked === 'challenge' ? 'edge_challenge' : 'service_paused', 'Service unavailable');
  }
  const payload = parseJson(await res.text());
  if (res.ok) return payload as T;
  if (res.status === 401 && opts.redirectOn401 !== false) redirectToConnect();
  throw readError(res.status, payload);
}

export const api = {
  get: <T>(path: string, opts?: CallOptions) => request<T>(path, opts),
  post: <T>(path: string, body?: unknown, opts?: CallOptions) =>
    request<T>(path, { ...opts, method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body: unknown, opts?: CallOptions) => request<T>(path, { ...opts, method: 'PATCH', body }),
  del: <T>(path: string, opts?: CallOptions) => request<T>(path, { ...opts, method: 'DELETE' }),
};
