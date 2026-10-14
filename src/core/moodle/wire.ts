/** Pure helpers behind MoodleClient: error envelopes, file URLs, multipart upload bodies. */

import { InvalidInput, MoodleError } from '../errors';

export type Json = Record<string, unknown>;
export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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

/** Validates host/path, rewrites `/pluginfile.php/` to the webservice endpoint and sets the token. */
export function fileDownloadUrl(base: { baseUrl: string; token: string }, fileUrl: string): string {
  let u: URL;
  try {
    u = new URL(fileUrl, `${base.baseUrl}/`);
  } catch {
    throw new InvalidInput('That is not a valid Moodle file URL.');
  }
  if (u.origin !== new URL(base.baseUrl).origin || !FILE_PREFIXES.some((p) => u.pathname.startsWith(p))) {
    throw new InvalidInput('Only files hosted on Waseda Moodle can be fetched.');
  }
  if (!u.pathname.startsWith('/webservice/')) u.pathname = `/webservice${u.pathname}`;
  u.username = '';
  u.password = '';
  u.hash = '';
  if (u.searchParams.has('token')) u.searchParams.delete('token');
  return `${u.origin}${u.pathname}${u.search}${u.search ? '&' : '?'}token=${encodeURIComponent(base.token)}`;
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
export function sanitizeFilename(name: string): string {
  const bad = (ch: string) => '/\\"'.includes(ch) || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127;
  const clean = Array.from(name, (ch) => (bad(ch) ? '_' : ch)).join('');
  return clean.trim();
}

interface Multipart {
  boundary: string;
  head: Uint8Array;
  tail: Uint8Array;
}

export function multipartParts(fields: { token: string; itemId: number; name: string; mime: string }): Multipart {
  const rand = crypto.getRandomValues(new Uint8Array(12));
  const boundary = `----wmm${Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const field = (n: string, v: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const fileHeader =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fields.name}"\r\n` +
    `Content-Type: ${fields.mime}\r\n\r\n`;
  const te = new TextEncoder();
  return {
    boundary,
    head: te.encode(
      field('token', fields.token) +
        field('itemid', String(Math.trunc(fields.itemId) || 0)) +
        field('filepath', '/') +
        fileHeader,
    ),
    tail: te.encode(`\r\n--${boundary}--\r\n`),
  };
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
