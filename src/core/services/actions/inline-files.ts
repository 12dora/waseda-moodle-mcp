/** Files passed straight to prepare_submission (text, base64 or, in local mode, a path). */

import type { ServiceContext } from '../../context';
import { InvalidInput, NotFound } from '../../errors';
import { formatBytes } from '../../format';
import type { InlineFile } from '../../types';
import { guessMime, sanitizeFileName } from './filenames';

/** Inline files in the Worker cost CPU (decode) and RAM; anything bigger goes through an upload link. */
const MAX_INLINE_WORKER_BYTES = 1024 * 1024;
/** Characters per atob() call in the fallback decoder (a multiple of 4). */
const B64_CHUNK = 32 * 1024;

export interface FileInfo {
  name: string;
  size: number;
  mime: string | null;
  /** Local mode: the real (symlink-resolved) path the bytes came from, shown in the preview. */
  source?: string;
}

export interface InlineUpload extends FileInfo {
  bytes: Uint8Array;
}

type Source = { kind: 'text' | 'base64' | 'path'; value: string };

interface Loaded {
  bytes: Uint8Array;
  source?: string;
}

type NativeBase64 = { fromBase64?: (s: string, o?: { lastChunkHandling: 'loose' }) => Uint8Array };

/** Native Uint8Array.fromBase64 when the runtime has it; otherwise chunked atob (no giant intermediate string). */
function bytesFromBase64(clean: string): Uint8Array {
  const native = (Uint8Array as unknown as NativeBase64).fromBase64;
  if (native) return native.call(Uint8Array, clean, { lastChunkHandling: 'loose' });
  const out = new Uint8Array(Math.ceil((clean.length * 3) / 4));
  let n = 0;
  for (let i = 0; i < clean.length; i += B64_CHUNK) {
    const bin = atob(clean.slice(i, i + B64_CHUNK));
    for (let j = 0; j < bin.length; j++) out[n++] = bin.charCodeAt(j);
  }
  return out.subarray(0, n);
}

function decodeBase64(b64: string, limit: number, name: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if ((clean.length * 3) / 4 > limit + 3) {
    throw new InvalidInput(
      `File '${name}' is larger than ${formatBytes(limit)}. Use create_upload_link for big files.`,
    );
  }
  try {
    return bytesFromBase64(clean);
  } catch {
    throw new InvalidInput(`File '${name}': content_base64 is not valid base64.`);
  }
}

/** Local mode guard: never upload hidden files/folders (keys, .env) or anything in our own config folder. */
async function assertReadablePath(requested: string, real: string, name: string): Promise<void> {
  const hidden = (p: string) => p.split(/[\\/]+/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');
  if (hidden(requested) || hidden(real)) {
    throw new InvalidInput(`File '${name}': hidden files and folders cannot be submitted.`);
  }
  const { homedir } = await import('node:os');
  const { join, sep } = await import('node:path');
  const fs = await import('node:fs/promises');
  const configDir = process.env.WMM_CONFIG_DIR || join(homedir(), '.config', 'waseda-moodle-mcp');
  const realConfig = await fs.realpath(configDir).catch(() => configDir);
  if (real === realConfig || real.startsWith(realConfig + sep)) {
    throw new InvalidInput(`File '${name}': files in the config folder cannot be submitted.`);
  }
}

async function readLocalFile(path: string, limit: number, name: string): Promise<Loaded> {
  if (!/^(\/|[A-Za-z]:[\\/])/.test(path)) throw new InvalidInput(`File '${name}': path must be absolute.`);
  const fs = await import('node:fs/promises');
  const real = await fs.realpath(path).catch(() => null);
  if (!real) throw new NotFound(`Local file not found: ${path}`);
  await assertReadablePath(path, real, name);
  const st = await fs.stat(real).catch(() => null);
  if (!st?.isFile()) throw new NotFound(`Local file not found: ${path}`);
  if (st.size > limit) throw new InvalidInput(`File '${name}' is larger than ${formatBytes(limit)}.`);
  return { bytes: new Uint8Array(await fs.readFile(real)), source: real };
}

function pickSource(f: InlineFile, name: string): Source {
  const sources: Source[] = [];
  if (f.text !== undefined) sources.push({ kind: 'text', value: f.text });
  if (f.contentBase64 !== undefined) sources.push({ kind: 'base64', value: f.contentBase64 });
  if (f.path !== undefined) sources.push({ kind: 'path', value: f.path });
  const [only] = sources;
  if (sources.length !== 1 || !only) {
    throw new InvalidInput(`File '${name}': provide exactly one of text, content_base64 or path.`);
  }
  return only;
}

interface Caps {
  /** Assignment / service limit per file. */
  limit: number;
  /** Smaller in the Worker, where inline bytes sit in memory. */
  inlineCap: number;
}

async function readSource(ctx: ServiceContext, source: Source, name: string, caps: Caps): Promise<Loaded> {
  if (source.kind === 'text') return { bytes: new TextEncoder().encode(source.value) };
  if (source.kind === 'base64') return { bytes: decodeBase64(source.value, caps.inlineCap, name) };
  if (ctx.mode !== 'stdio') throw new InvalidInput(`File '${name}': path is only supported in local (stdio) mode.`);
  return readLocalFile(source.value, caps.limit, name);
}

function assertSize(name: string, size: number, caps: Caps): void {
  if (size === 0) throw new InvalidInput(`File '${name}' is empty.`);
  if (size > caps.limit) {
    throw new InvalidInput(`File '${name}' is ${formatBytes(size)}; the limit is ${formatBytes(caps.limit)}.`);
  }
  if (size > caps.inlineCap) {
    throw new InvalidInput(
      `File '${name}' is ${formatBytes(size)}; inline files are limited to ${formatBytes(caps.inlineCap)}. Use create_upload_link for big files.`,
    );
  }
}

export async function resolveInlineFiles(
  ctx: ServiceContext,
  files: InlineFile[],
  limit: number,
): Promise<InlineUpload[]> {
  const caps: Caps = { limit, inlineCap: ctx.mode === 'stdio' ? limit : Math.min(limit, MAX_INLINE_WORKER_BYTES) };
  const out: InlineUpload[] = [];
  for (const f of files) {
    const name = sanitizeFileName(typeof f?.name === 'string' ? f.name : '');
    if (!name) throw new InvalidInput('Every file needs a name.');
    const { bytes, source } = await readSource(ctx, pickSource(f, name), name, caps);
    assertSize(name, bytes.length, caps);
    out.push({ name, size: bytes.length, mime: guessMime(name), bytes, ...(source ? { source } : {}) });
  }
  return out;
}
