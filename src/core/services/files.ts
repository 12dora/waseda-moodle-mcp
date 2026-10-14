/**
 * File passthrough: signed download links (Moodle pluginfile -> client, never buffered), signed upload links
 * (client raw bytes -> Moodle draft area, never buffered) and the small inline-content option for tiny files.
 * The HTTP routes that serve the tickets live in file-http.ts (re-exported here).
 *
 * Node-only code (stdio mode: download to a temp file) is behind dynamic imports so the Worker bundle never loads it.
 */

import type { MoodleApi, ServiceContext } from '../context';
import { randomId } from '../crypto';
import {
  BudgetExceeded,
  Forbidden,
  InvalidInput,
  MoodleError,
  MoodleUnavailable,
  NeedsReconnect,
  NotFound,
  WmmError,
} from '../errors';
import { htmlToMarkdown } from '../html';
import { isoJst, nowMs } from '../time';
import type { FileLink, UploadLink } from '../types';
import { guessMime } from './actions/filenames';
import { assertWriteAllowed, auditSafe, DEFAULT_MAX_FILES } from './actions/shared';
import { checkSubmissionWindow, fileSizeLimit } from './actions/submission-checks';
import { getActivity } from './activity';
import { nameFromHeaders } from './file-http';

export { type FileRouteEnv, streamDownload, streamUpload } from './file-http';

const DOWNLOAD_TTL_SEC = 15 * 60;
const UPLOAD_TTL_SEC = 30 * 60;
const INLINE_MAX_BYTES = 1024 * 1024;

// ------------------------------------------------------------------ helpers

/** Same rules as MoodleApi.fetchFile: own host, pluginfile path only; token stripped; returns path + query. */
function normalizeFilePath(baseUrl: string, fileUrl: string): string {
  let u: URL;
  let base: URL;
  try {
    base = new URL(baseUrl);
    u = new URL(fileUrl);
  } catch {
    throw new InvalidInput('That is not a valid file URL.');
  }
  if (u.origin !== base.origin) throw new InvalidInput('Only files hosted on Waseda Moodle can be fetched.');
  let path = u.pathname;
  if (path.startsWith('/pluginfile.php/')) path = `/webservice${path}`;
  if (!path.startsWith('/webservice/pluginfile.php/')) {
    throw new InvalidInput('Only Moodle file URLs (pluginfile.php) can be fetched.');
  }
  u.searchParams.delete('token');
  const q = u.searchParams.toString();
  return q ? `${path}?${q}` : path;
}

function mimeFrom(headers: Headers, name: string): string | null {
  const ct = headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (ct && ct !== 'application/octet-stream') return ct;
  return guessMime(name) ?? (ct || null);
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(s);
}

/** Reads at most `limit` bytes; null when the body is larger (the rest is discarded). */
async function readLimited(res: Response, limit: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const isTextMime = (m: string) =>
  m.startsWith('text/') ||
  m === 'application/json' ||
  m === 'application/xml' ||
  m.endsWith('+json') ||
  m.endsWith('+xml');

async function buildInline(api: MoodleApi, path: string, mime: string | null): Promise<FileLink['inline']> {
  if (!mime) return null;
  const asText = isTextMime(mime);
  if (!asText && !mime.startsWith('image/') && mime !== 'application/pdf') return null;
  const res = await api.fetchFile(`${api.baseUrl}${path}`);
  if (!res.ok) return null;
  const bytes = await readLimited(res, INLINE_MAX_BYTES);
  if (!bytes) return null;
  if (!asText) return { mime, base64: toBase64(bytes) };
  const text = new TextDecoder().decode(bytes);
  if (mime === 'text/html') return { mime: 'text/markdown', text: htmlToMarkdown(text) };
  return { mime, text };
}

async function downloadToTemp(api: MoodleApi, path: string, name: string): Promise<string> {
  const res = await api.fetchFile(`${api.baseUrl}${path}`);
  if (!res.ok || !res.body) throw new MoodleUnavailable('Moodle did not return the file. Try again later.');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const url = await import('node:url');
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'wmm-'));
  const file = nodePath.join(dir, name);
  const fh = await fs.open(file, 'w', 0o600);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await fh.write(value);
    }
  } finally {
    await fh.close();
  }
  return url.pathToFileURL(file).href;
}

// ------------------------------------------------------------------ download link

const FATAL_PROBE_ERRORS = [NeedsReconnect, NotFound, Forbidden, BudgetExceeded];

/** HEAD for size / mime / name. Failures other than "gone", "forbidden" or "reconnect" just mean no metadata. */
async function probeHeaders(api: MoodleApi, path: string): Promise<Headers> {
  try {
    const head = await api.fetchFile(`${api.baseUrl}${path}`, { method: 'HEAD' });
    if (head.status === 404) throw new NotFound('That file was not found in Moodle.');
    if (head.status === 403) throw new Forbidden('You do not have access to that file in Moodle.');
    void head.body?.cancel().catch(() => undefined);
    return head.headers;
  } catch (e) {
    if (!(e instanceof WmmError) || FATAL_PROBE_ERRORS.some((c) => e instanceof c)) throw e;
    return new Headers();
  }
}

function sizeFrom(headers: Headers): number | null {
  const raw = headers.get('content-length');
  const len = Number(raw);
  return raw !== null && Number.isFinite(len) && len >= 0 ? len : null;
}

export async function createFileLink(
  ctx: ServiceContext,
  fileUrl: string,
  opts: { inline?: boolean } = {},
): Promise<FileLink> {
  const api = await ctx.moodle();
  const path = normalizeFilePath(api.baseUrl, fileUrl);
  const headers = await probeHeaders(api, path);
  const name = nameFromHeaders(headers, path);
  const mime = mimeFrom(headers, name);
  const size = sizeFrom(headers);
  const expiresAt = isoJst(nowMs() + DOWNLOAD_TTL_SEC * 1000);
  const wantsInline = opts.inline && size !== null && size <= INLINE_MAX_BYTES;
  const inline = wantsInline ? await buildInline(api, path, mime) : null;

  await auditSafe(ctx, 'file:link', { name, size });
  if (ctx.mode === 'stdio') {
    const downloadUrl = await downloadToTemp(api, path, name);
    return { name, mime, size, downloadUrl, expiresAt, inline };
  }
  const ticket = await ctx.signer.sign({ k: 'dl', u: ctx.user.id, p: path, n: name }, DOWNLOAD_TTL_SEC);
  return { name, mime, size, downloadUrl: `${ctx.publicUrl}/f/${ticket}`, expiresAt, inline };
}

// ------------------------------------------------------------------ upload link

async function allocateDraftItem(api: MoodleApi): Promise<number> {
  const draft = await api.call<{ itemid?: unknown }>('core_files_get_unused_draft_itemid');
  const itemId = typeof draft?.itemid === 'number' ? draft.itemid : Number.NaN;
  if (!Number.isInteger(itemId) || itemId <= 0) throw new MoodleError('Moodle did not return a draft area.', 'nodraft');
  return itemId;
}

export async function createUploadLink(ctx: ServiceContext, cmid: number): Promise<UploadLink> {
  assertWriteAllowed(ctx);
  if (ctx.mode === 'stdio' || !ctx.publicUrl) {
    throw new InvalidInput(
      'Upload links are not available in local mode; pass files[].path to prepare_submission instead.',
    );
  }
  if (!Number.isInteger(cmid) || cmid <= 0) throw new InvalidInput('cmid must be a positive integer.');
  const act = await getActivity(ctx, cmid);
  if (act.type !== 'assign') throw new InvalidInput('This activity is not an assignment.');
  if (!act.submissionTypes.includes('file'))
    throw new InvalidInput('This assignment does not accept file submissions.');
  checkSubmissionWindow(act, nowMs());

  const maxBytes = fileSizeLimit(act);
  const maxFiles = act.maxFiles && act.maxFiles > 0 ? act.maxFiles : DEFAULT_MAX_FILES;
  const draftItemId = await allocateDraftItem(await ctx.moodle());

  const now = nowMs();
  const expiresMs = now + UPLOAD_TTL_SEC * 1000;
  const uploadId = randomId('upl');
  await ctx.store.createUploadDraft({
    id: uploadId,
    userId: ctx.user.id,
    cmid,
    draftItemId,
    files: [],
    totalBytes: 0,
    createdAt: now,
    expiresAt: expiresMs,
  });
  const ticket = await ctx.signer.sign(
    { k: 'up', u: ctx.user.id, d: uploadId, mb: maxBytes, mf: maxFiles },
    UPLOAD_TTL_SEC,
  );
  const uploadUrl = `${ctx.publicUrl}/u/${ticket}`;
  await auditSafe(ctx, 'upload:create', { cmid, uploadId });
  return {
    uploadUrl,
    uploadId,
    draftItemId,
    expiresAt: isoJst(expiresMs),
    maxBytes,
    curlExample: `curl -T ./report.pdf "${uploadUrl}?name=report.pdf"`,
  };
}
