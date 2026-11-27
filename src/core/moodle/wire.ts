/** Pure helpers behind the Moodle clients: error envelopes, session cookies, file URLs, multipart upload bodies. */

import { InvalidInput, MoodleError } from '../errors';

export type Json = Record<string, unknown>;
export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ------------------------------------------------------------------ parameters

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

// ------------------------------------------------------------------ error envelopes

interface Envelope {
  code: string;
  message: string;
  exception: string;
  debuginfo: string;
}

/** Returns the parsed error object, or null for ordinary data. Upload/pluginfile errors use `error` for the text. */
export function readEnvelope(o: Json): Envelope | null {
  const code = str(o.errorcode);
  const exception = str(o.exception);
  const message = str(o.message) || str(o.error);
  if (!exception && !(code && message)) return null;
  return { code, message, exception, debuginfo: str(o.debuginfo) };
}

/** invalidtoken, or an accessexception whose message/debuginfo says the token expired or is invalid. */
export function isTokenGone(e: Envelope): boolean {
  if (e.code === 'invalidtoken') return true;
  const says = (t: string) => /token/i.test(t) && /expire|invalid/i.test(t);
  return e.code === 'accessexception' && (says(e.message) || says(e.debuginfo));
}

// ------------------------------------------------------------------ session cookie

/**
 * The session cookie of a Set-Cookie line (the name may carry the site's `sessioncookie` suffix). The "deleted"
 * value PHP sends when it drops a session never matches.
 */
const SESSION_COOKIE = /^\s*(MoodleSession\w*)=(?!deleted\s*(?:;|$))([A-Za-z0-9,-]+)\s*(?:;|$)/;

/** The last session cookie (`MoodleSession=<value>`) the response sets (Moodle sends several while it regenerates). */
export function sessionCookie(res: Response): string | null {
  let found: string | null = null;
  for (const line of res.headers.getSetCookie()) {
    const m = SESSION_COOKIE.exec(line);
    if (m) found = `${m[1]}=${m[2]}`;
  }
  return found;
}

// ------------------------------------------------------------------ bytes

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const PEEK_LIMIT = 4096;

/** A JSON response that could be a small Moodle error object (never a real file download). */
export function looksLikeSmallJson(res: Response): boolean {
  const len = Number(res.headers.get('content-length') ?? Number.NaN);
  return !!res.body && !(len > PEEK_LIMIT) && /json/i.test(res.headers.get('content-type') ?? '');
}

/** Reads at most 4 KiB of a clone; returns the parsed JSON, or undefined for larger/non-JSON bodies. */
export async function peekJson(res: Response): Promise<unknown> {
  const reader = res.clone().body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let n = 0;
  let complete = false;
  try {
    while (n <= PEEK_LIMIT && !complete) {
      const r = await reader.read();
      complete = r.done;
      if (!r.done) {
        chunks.push(r.value);
        n += r.value.length;
      }
    }
  } catch {
    return undefined;
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!complete) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(concat(chunks)));
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ file URLs

const FILE_PREFIXES = ['/webservice/pluginfile.php/', '/pluginfile.php/'];
/** The session may also read the user's own draft files (a post's current attachments); never with a token. */
const SESSION_FILE_PREFIXES = [...FILE_PREFIXES, '/draftfile.php/'];
const FOLDER_ZIP_WS_MSG =
  'Folder ZIP downloads are only available through the Moodle web session; list the folder files with get_activity.';

/** A file URL on baseUrl under one of `prefixes`, without credentials, fragment and `token`. */
function cleanFileUrl(baseUrl: string, fileUrl: string, prefixes = FILE_PREFIXES): URL {
  let u: URL;
  try {
    u = new URL(fileUrl, `${baseUrl}/`);
  } catch {
    throw new InvalidInput('That is not a valid Moodle file URL.');
  }
  if (u.origin !== new URL(baseUrl).origin || !prefixes.some((p) => u.pathname.startsWith(p))) {
    throw new InvalidInput('Only files hosted on Waseda Moodle can be fetched.');
  }
  u.username = '';
  u.password = '';
  u.hash = '';
  if (u.searchParams.has('token')) u.searchParams.delete('token');
  return u;
}

/** Validates host/path, rewrites `/pluginfile.php/` to the webservice endpoint and sets the token. */
export function fileDownloadUrl(base: { baseUrl: string; token: string }, fileUrl: string): string {
  if (isFolderZipUrl(base.baseUrl, fileUrl)) throw new InvalidInput(FOLDER_ZIP_WS_MSG);
  const u = cleanFileUrl(base.baseUrl, fileUrl);
  if (!u.pathname.startsWith('/webservice/')) u.pathname = `/webservice${u.pathname}`;
  return `${u.origin}${u.pathname}${u.search}${u.search ? '&' : '?'}token=${encodeURIComponent(base.token)}`;
}

/**
 * A folder's ZIP, `/mod/folder/download_folder.php?id=<cmid>` exactly (no other parameter): the one page besides
 * file URLs the web session may fetch as a file. The web-service token cannot fetch it.
 */
const FOLDER_ZIP = /^\/mod\/folder\/download_folder\.php\?id=[1-9]\d{0,9}$/;

export const FOLDER_ZIP_PATH = '/mod/folder/download_folder.php';

/** `path` (path + query) is exactly a folder ZIP download. */
export const isFolderZipPath = (path: string): boolean => FOLDER_ZIP.test(path);

/** The absolute folder ZIP URL when `fileUrl` is exactly one on baseUrl; null otherwise. */
function folderZipUrl(baseUrl: string, fileUrl: string): string | null {
  const u = URL.canParse(fileUrl, `${baseUrl}/`) ? new URL(fileUrl, `${baseUrl}/`) : null;
  if (!u || u.origin !== new URL(baseUrl).origin || !isFolderZipPath(`${u.pathname}${u.search}`)) return null;
  return `${u.origin}${u.pathname}${u.search}`;
}

/** `fileUrl` is exactly a folder ZIP download on baseUrl (only the web session can fetch it). */
export function isFolderZipUrl(baseUrl: string, fileUrl: string): boolean {
  return folderZipUrl(baseUrl, fileUrl) !== null;
}

/**
 * The web session's form of a file URL: `/pluginfile.php/…`, `/draftfile.php/…` (the cookie authenticates) or a
 * folder's ZIP.
 */
export function sessionFileUrl(baseUrl: string, fileUrl: string): string {
  const zip = folderZipUrl(baseUrl, fileUrl);
  if (zip) return zip;
  const u = cleanFileUrl(baseUrl, fileUrl, SESSION_FILE_PREFIXES);
  u.pathname = u.pathname.replace(/^\/webservice\//, '/');
  return u.toString();
}

// ------------------------------------------------------------------ upload.php

export interface UploadFile {
  name: string;
  body: ReadableStream<Uint8Array> | Uint8Array;
  size: number;
  mime?: string | null;
}

interface FixedLengthStreamCtor {
  new (length: number): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
}

/** Header-safe file name: path separators, quotes and control characters become `_`. */
function sanitizeFilename(name: string): string {
  const bad = (ch: string) => '/\\"'.includes(ch) || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127;
  const clean = Array.from(name, (ch) => (bad(ch) ? '_' : ch)).join('');
  return clean.trim();
}

interface Multipart {
  boundary: string;
  head: Uint8Array;
  tail: Uint8Array;
}

/** The file part of a multipart upload: its form field name and the sanitised file name / MIME type. */
interface MultipartFile {
  field: string;
  name: string;
  mime: string;
}

/** Head (the form fields, then the file part's header) and tail of a multipart body around the file bytes. */
export function multipartParts(fields: ReadonlyArray<readonly [string, string]>, file: MultipartFile): Multipart {
  const rand = crypto.getRandomValues(new Uint8Array(12));
  const boundary = `----wmm${Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const field = ([n, v]: readonly [string, string]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const fileHeader =
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n` +
    `Content-Type: ${file.mime}\r\n\r\n`;
  const te = new TextEncoder();
  return {
    boundary,
    head: te.encode(fields.map(field).join('') + fileHeader),
    tail: te.encode(`\r\n--${boundary}--\r\n`),
  };
}

/** Validates an upload's size and name; the header-safe name and MIME type to send. */
export function uploadMeta(file: UploadFile): { name: string; mime: string } {
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new InvalidInput('The file size is invalid.');
  const name = sanitizeFilename(file.name);
  if (!name) throw new InvalidInput('The file needs a name.');
  const mime = (file.mime ?? '').replace(/[\r\n;]+/g, '') || 'application/octet-stream';
  return { name, mime };
}

/** A fresh draft item id (what Moodle's core_files_get_unused_draft_itemid hands out: 1..999999999). */
export function randomDraftItemId(): number {
  const [n = 0] = crypto.getRandomValues(new Uint32Array(1));
  return (n % 999_999_999) + 1;
}

async function collect(body: ReadableStream<Uint8Array>, parts: Multipart): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [parts.head];
  const reader = body.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  chunks.push(parts.tail);
  return concat(chunks);
}

function fixedLengthBody(
  ctor: FixedLengthStreamCtor,
  body: ReadableStream<Uint8Array>,
  size: number,
  p: Multipart,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const source = new ReadableStream<Uint8Array>({
    start: (c) => c.enqueue(p.head),
    async pull(c) {
      const r = await reader.read();
      if (r.done) {
        c.enqueue(p.tail);
        c.close();
      } else c.enqueue(r.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  const fls = new ctor(p.head.length + size + p.tail.length);
  source.pipeTo(fls.writable).catch(() => {});
  return fls.readable;
}

/** Request body: a buffer for small inputs, a FixedLengthStream (exact Content-Length) on Workers, else collected. */
export async function uploadBody(file: UploadFile, parts: Multipart): Promise<{ body: BodyInit; duplex?: 'half' }> {
  if (file.body instanceof Uint8Array) {
    return { body: concat([parts.head, file.body, parts.tail]) as unknown as BodyInit };
  }
  const ctor = (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
  if (ctor) {
    const stream = fixedLengthBody(ctor, file.body, file.size, parts);
    return { body: stream as unknown as BodyInit, duplex: 'half' };
  }
  return { body: (await collect(file.body, parts)) as unknown as BodyInit };
}

/** upload.php reports per-file problems (`errortype`/`error`) inside a 200 answer. */
export function uploadError(rec: Json): MoodleError | null {
  if (typeof rec.errortype !== 'string' && !(typeof rec.error === 'string' && rec.itemid === undefined)) return null;
  return new MoodleError(str(rec.error) || 'Moodle rejected the upload.', str(rec.errortype) || 'upload_failed');
}
