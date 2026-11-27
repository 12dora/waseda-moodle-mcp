/**
 * HTTP side of the file passthrough (called by worker/files-routes.ts): signed-ticket downloads and raw-byte uploads.
 * Moodle bodies are streamed both ways, never buffered. Gmail attachment tickets (`k: 'ml'`) buffer (≤ 5 MB)
 * because Gmail serves them as base64 JSON.
 */

import type { MailApi, MoodleApi, Signer, Store, UploadDraftRow } from '../context';
import {
  BudgetExceeded,
  Forbidden,
  InvalidInput,
  MailUnavailable,
  MoodleError,
  MoodleUnavailable,
  NeedsReconnect,
  NotFound,
  WmmError,
} from '../errors';
import { bytesOfBase64Url } from '../mail/gmail';
import { nowMs } from '../time';
import { guessMime, sanitizeFileName } from './actions/filenames';
import { DEFAULT_MAX_FILES, MAX_DRAFT_TOTAL_BYTES, MAX_FILE_BYTES } from './actions/shared';

/** What the HTTP routes provide; no per-request user context exists there. */
export interface FileRouteEnv {
  store: Store;
  signer: Signer;
  makeMoodle(userId: number): Promise<MoodleApi>;
  /** BE-1 wires this for Gmail attachment tickets; absent → those tickets 404. */
  makeMail?(userId: number): Promise<MailApi>;
}

// ------------------------------------------------------------------ responses

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...extra },
  });
}

const fail = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  jsonResponse(status, { error: { code, message } }, extra);

function statusOf(e: WmmError): number {
  if (e instanceof NotFound) return 404;
  if (e instanceof Forbidden) return 403;
  if (e instanceof InvalidInput) return 400;
  if (e instanceof NeedsReconnect) return 401;
  if (e instanceof BudgetExceeded) return 429;
  const badGateway = e instanceof MoodleError || e instanceof MoodleUnavailable || e instanceof MailUnavailable;
  return badGateway ? 502 : 500;
}

function errorResponse(e: unknown): Response {
  if (!(e instanceof WmmError)) return fail(500, 'error', 'Unexpected error.');
  return fail(statusOf(e), e.code, e.message);
}

// ------------------------------------------------------------------ names

function dispositionName(cd: string): string | null {
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      /* fall back to the plain filename */
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/.exec(cd)?.[1] ?? /filename\s*=\s*([^;]+)/.exec(cd)?.[1]?.trim();
  return plain ? headerUtf8(plain) : null;
}

/**
 * Header values arrive as bytes read one per character (Latin-1); Moodle puts the raw UTF-8 bytes of the name in the
 * quoted `filename`. Valid UTF-8 is decoded; anything else stays as it is.
 */
function headerUtf8(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value) || [...value].some((c) => c.charCodeAt(0) > 0xff)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));
  } catch {
    return value;
  }
}

function pathName(path: string): string {
  const last = path.split('?')[0]?.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function nameFromHeaders(headers: Headers, path: string): string {
  const raw = dispositionName(headers.get('content-disposition') ?? '') ?? pathName(path);
  return sanitizeFileName(raw) || 'file';
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const BAD_TICKET = 'This download link is invalid or has expired.';

// ------------------------------------------------------------------ download

type DownloadTicket = { k?: string; u?: number; p?: string; n?: string };
type MailTicket = { u: number; m: string; a: string; n: string; t: string; s: number };

function mailTicketOf(t: Record<string, unknown>): MailTicket | null {
  if (t.k !== 'ml' || typeof t.u !== 'number' || typeof t.m !== 'string' || typeof t.a !== 'string') return null;
  return {
    u: t.u,
    m: t.m,
    a: t.a,
    n: typeof t.n === 'string' ? t.n : '',
    t: typeof t.t === 'string' ? t.t : 'application/octet-stream',
    s: typeof t.s === 'number' && t.s >= 0 ? t.s : 0,
  };
}

function fileHeaders(type: string, name: string, extra: Record<string, string> = {}): Headers {
  return new Headers({
    'content-type': type || 'application/octet-stream',
    'content-disposition': contentDisposition(name),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    ...extra,
  });
}

/** Passive types served as-is; everything else is octet-stream (html/svg/xml/js and unknown active types). */
const PASSIVE_MAIL_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/heic',
  'text/plain',
  'text/csv',
  'application/zip',
]);
const OPENXML = 'application/vnd.openxmlformats-officedocument.';

function mailTypeOf(type: string): string {
  const t = (type.split(';')[0] ?? '').trim().toLowerCase();
  if (!t) return 'application/octet-stream';
  if (PASSIVE_MAIL_TYPES.has(t)) return t;
  if (t.startsWith(OPENXML) || t.startsWith('audio/') || t.startsWith('video/')) return t;
  return 'application/octet-stream';
}

function skipWs(s: string, from: number): number {
  let i = from;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i += 1;
  return i;
}

/** Pulls `"data": "…"` out of Gmail attachment JSON without JSON.parse of the whole body. */
function dataOfAttachmentJson(text: string): string {
  const key = '"data"';
  const at = text.indexOf(key);
  if (at < 0) throw new MailUnavailable();
  let i = skipWs(text, at + key.length);
  if (text[i] !== ':') throw new MailUnavailable();
  i = skipWs(text, i + 1);
  if (text[i] !== '"') throw new MailUnavailable();
  const from = i + 1;
  const to = text.indexOf('"', from);
  if (to < 0) throw new MailUnavailable();
  const data = text.slice(from, to);
  if (!data) throw new MailUnavailable();
  return data;
}

/** Gmail serves attachments as base64 JSON, so this path buffers (≤ 5 MB) unlike Moodle files. */
async function proxyMailDownload(env: FileRouteEnv, t: MailTicket, request: Request): Promise<Response> {
  const name = sanitizeFileName(t.n) || 'file';
  const headers = fileHeaders(mailTypeOf(t.t), name, { 'content-length': String(t.s) });
  // HEAD answers from the ticket (size/type) without calling Gmail, even if mail has since been disconnected.
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  if (!env.makeMail) throw new NotFound(BAD_TICKET);
  const api = await env.makeMail(t.u);
  const bytes = bytesOfBase64Url(dataOfAttachmentJson(await api.getText(`messages/${t.m}/attachments/${t.a}`)));
  headers.set('content-length', String(bytes.byteLength));
  return new Response(bytes, { status: 200, headers });
}

/** The response to send instead of the upstream one, or null when the upstream answer is the file. */
function upstreamFailure(upstream: Response, name: string): Response | null {
  if (upstream.status === 404) return fail(404, 'not_found', 'That file no longer exists in Moodle.');
  if (upstream.status === 403) return fail(403, 'forbidden', 'You do not have access to that file in Moodle.');
  // Moodle answers token problems with a JSON error body, not an HTTP error
  const jsonBody = /^application\/json/i.test(upstream.headers.get('content-type') ?? '');
  if (upstream.ok && !(jsonBody && !/\.json$/i.test(name))) return null;
  if (upstream.status === 416) return fail(416, 'range_not_satisfiable', 'Range not satisfiable.');
  return fail(502, 'moodle_error', 'Moodle did not return the file. Reconnect in the console if this keeps happening.');
}

function downloadHeaders(upstream: Response, name: string): Headers {
  const extra: Record<string, string> = {};
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) extra[h] = v;
  }
  return fileHeaders(upstream.headers.get('content-type') ?? 'application/octet-stream', name, extra);
}

async function proxyDownload(env: FileRouteEnv, t: Required<DownloadTicket>, request: Request): Promise<Response> {
  const api = await env.makeMoodle(t.u);
  const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
  const upstream = await api.fetchFile(`${api.baseUrl}${t.p}`, {
    method,
    range: request.headers.get('range') ?? undefined,
  });
  const name = sanitizeFileName(t.n) || nameFromHeaders(upstream.headers, t.p);
  const failure = upstreamFailure(upstream, name);
  if (failure) {
    void upstream.body?.cancel().catch(() => undefined);
    return failure;
  }
  return new Response(method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: downloadHeaders(upstream, name),
  });
}

export async function streamDownload(env: FileRouteEnv, ticket: string, request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail(405, 'method_not_allowed', 'Use GET.', { allow: 'GET, HEAD' });
  }
  const t = await env.signer.verify<DownloadTicket & Record<string, unknown>>(ticket);
  try {
    if (t?.k === 'ml') {
      const mail = mailTicketOf(t);
      if (!mail) return fail(404, 'not_found', BAD_TICKET);
      return await proxyMailDownload(env, mail, request);
    }
    if (t?.k !== 'dl' || typeof t.u !== 'number' || typeof t.p !== 'string') {
      return fail(404, 'not_found', BAD_TICKET);
    }
    return await proxyDownload(env, { k: 'dl', u: t.u, p: t.p, n: t.n ?? '' }, request);
  } catch (e) {
    return errorResponse(e);
  }
}

// ------------------------------------------------------------------ upload

type UploadTicket = { k?: string; u?: number; d?: string; mb?: number; mf?: number };

interface UploadRequest {
  name: string;
  size: number;
  contentType: string;
  body: ReadableStream<Uint8Array>;
}

/** Validates the request shape (name, raw body, Content-Length); returns the error response otherwise. */
function readUploadRequest(request: Request): UploadRequest | Response {
  const name = sanitizeFileName(new URL(request.url).searchParams.get('name') ?? '');
  if (!name) return fail(400, 'invalid_input', 'The "name" query parameter (file name) is required.');
  const contentType = request.headers.get('content-type') ?? '';
  if (/^multipart\//i.test(contentType)) {
    return fail(415, 'unsupported_media_type', 'Send the raw file bytes, not multipart form data (curl -T file URL).');
  }
  if (/chunked/i.test(request.headers.get('transfer-encoding') ?? '')) {
    return fail(411, 'length_required', 'Content-Length is required (chunked uploads are not supported).');
  }
  const length = request.headers.get('content-length');
  if (length === null || !/^\d+$/.test(length)) return fail(411, 'length_required', 'Content-Length is required.');
  const size = Number(length);
  if (size === 0 || !request.body) return fail(400, 'invalid_input', 'The file is empty.');
  return { name, size, contentType, body: request.body };
}

interface UploadLimits {
  maxBytes: number;
  maxFiles: number;
}

function limitsOf(t: UploadTicket): UploadLimits {
  const maxBytes = typeof t.mb === 'number' && t.mb > 0 ? t.mb : MAX_FILE_BYTES;
  return {
    maxBytes: Math.min(maxBytes, MAX_FILE_BYTES),
    maxFiles: typeof t.mf === 'number' && t.mf > 0 ? t.mf : DEFAULT_MAX_FILES,
  };
}

/** Quota / duplicate checks against the draft; null when the file fits. */
function draftRefusal(draft: UploadDraftRow, up: UploadRequest, limits: UploadLimits): Response | null {
  if (draft.files.some((f) => f.name.toLowerCase() === up.name.toLowerCase())) {
    return fail(409, 'conflict', `A file named "${up.name}" was already uploaded to this link.`);
  }
  if (draft.files.length >= limits.maxFiles) return fail(409, 'conflict', `Too many files (limit ${limits.maxFiles}).`);
  if (draft.totalBytes + up.size > MAX_DRAFT_TOTAL_BYTES) {
    return fail(413, 'payload_too_large', 'The total upload size limit was reached.');
  }
  return null;
}

function uploadMime(contentType: string, name: string): string | null {
  const raw = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  const generic = !raw || raw === 'application/octet-stream' || raw.includes('x-www-form-urlencoded');
  return generic ? guessMime(name) : raw;
}

async function pipeUpload(
  env: FileRouteEnv,
  userId: number,
  draft: UploadDraftRow,
  up: UploadRequest,
): Promise<Response> {
  const api = await env.makeMoodle(userId);
  const mime = uploadMime(up.contentType, up.name);
  const upload = { name: up.name, body: up.body, size: up.size, mime };
  const res = await api.uploadToDraft(upload, draft.draftItemId, { cmid: draft.cmid });
  const file = { name: up.name, size: res.filesize || up.size, mime };
  await env.store.appendUploadedFile(draft.id, file);
  try {
    const detail = { uploadId: draft.id, name: file.name, size: file.size };
    await env.store.audit({ userId, at: nowMs(), actor: 'system', action: 'upload:file', detail });
  } catch {
    /* best effort */
  }
  const files = [...draft.files, file].map((f) => ({ name: f.name, size: f.size }));
  return jsonResponse(200, { ok: true, file: { name: file.name, size: file.size }, files });
}

/** Moodle-side rejections that the uploader can act on get their own status. */
function uploadErrorResponse(e: unknown): Response {
  if (e instanceof MoodleError) {
    const text = `${e.errorcode} ${e.message}`;
    if (/exist/i.test(text)) return fail(409, 'conflict', e.message);
    if (/oversize|toolarge|quota/i.test(text)) return fail(413, 'payload_too_large', e.message);
  }
  return errorResponse(e);
}

export async function streamUpload(env: FileRouteEnv, ticket: string, request: Request): Promise<Response> {
  if (request.method !== 'PUT' && request.method !== 'POST') {
    return fail(405, 'method_not_allowed', 'Use PUT or POST with the raw file bytes.', { allow: 'PUT, POST' });
  }
  const t = await env.signer.verify<UploadTicket>(ticket);
  if (t?.k !== 'up' || typeof t.u !== 'number' || typeof t.d !== 'string') {
    return fail(404, 'not_found', 'This upload link is invalid or has expired.');
  }
  const up = readUploadRequest(request);
  if (up instanceof Response) return up;
  const limits = limitsOf(t);
  if (up.size > limits.maxBytes) {
    return fail(413, 'payload_too_large', `File too large (limit ${limits.maxBytes} bytes per file).`);
  }
  const draft = await env.store.getUploadDraft(t.d);
  if (!draft || draft.userId !== t.u || draft.expiresAt <= nowMs()) {
    return fail(404, 'not_found', 'This upload link is invalid or has expired.');
  }
  const refusal = draftRefusal(draft, up, limits);
  if (refusal) return refusal;
  try {
    return await pipeUpload(env, t.u, draft, up);
  } catch (e) {
    return uploadErrorResponse(e);
  }
}
