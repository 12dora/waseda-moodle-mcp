/**
 * The stdio side of download_course_files: every file saved into ONE new local directory (in the OS temp dir or a
 * chosen one), keeping the section structure, with the get_file local-copy code (services/files.ts: 50 MB cap per
 * file, nothing left behind on a failure). Node-only modules are imported dynamically (the Worker never runs this).
 */

import type { MoodleApi } from '../context';
import { BudgetExceeded, InvalidInput, NeedsReconnect, NotFound, RateLimited, WmmError } from '../errors';
import type { DownloadFailure, DownloadFile, Placed } from './downloads';
import { browserUrl, LOCAL_COPY_MAX_BYTES, makeDownloadDir, saveMoodleFile } from './files';

const FATAL = [NeedsReconnect, BudgetExceeded, RateLimited];
const MAX_NAME_TRIES = 20;
const ZIP_UNAVAILABLE =
  'Moodle does not offer this folder as a ZIP (the teacher may have turned that off); list its files with get_activity.';

/** The user-safe reason of a failure that concerns one activity or file; anything else is rethrown. */
export function failureReason(e: unknown): string {
  if (e instanceof WmmError && !FATAL.some((c) => e instanceof c)) return e.message;
  throw e;
}

/** `a/b.pdf` → `a/b (2).pdf`. */
export function withSuffix(path: string, n: number): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const at = dot > slash + 1 ? dot : path.length;
  return `${path.slice(0, at)} (${n})${path.slice(at)}`;
}

/** Where the files go: an existing directory to continue in, or the parent of a new one (undefined = temp dir). */
interface LocalTarget {
  dir: string | null;
  parent?: string;
}

/** Validates `dest_dir` before anything is requested from Moodle; with a cursor it is the directory to continue in. */
export async function prepareLocalDir(destDir: string | undefined, continuing: boolean): Promise<LocalTarget> {
  if (destDir === undefined) return { dir: null };
  const nodePath = await import('node:path');
  const fs = await import('node:fs/promises');
  if (!nodePath.isAbsolute(destDir)) throw new InvalidInput('dest_dir must be an absolute path.');
  const st = await fs.stat(destDir).catch(() => null);
  if (!st?.isDirectory()) throw new InvalidInput('dest_dir does not exist or is not a directory.');
  return continuing ? { dir: destDir } : { dir: null, parent: destDir };
}

const isExists = (e: unknown) => e instanceof Error && 'code' in e && e.code === 'EEXIST';

/** Saves under `rel` or, when that name is taken (an earlier call), `rel (2)` …; the relative path used. */
async function saveUnique(api: MoodleApi, dir: string, p: Placed): Promise<{ rel: string; complete: boolean }> {
  const nodePath = await import('node:path');
  const fs = await import('node:fs/promises');
  for (let n = 1; ; n++) {
    const rel = n === 1 ? p.file.path : withSuffix(p.file.path, n);
    const target = nodePath.join(dir, ...rel.split('/'));
    await fs.mkdir(nodePath.dirname(target), { recursive: true, mode: 0o700 });
    try {
      return { rel, complete: await saveMoodleFile(api, p.moodlePath, target) };
    } catch (e) {
      if (!isExists(e) || n >= MAX_NAME_TRIES) throw e;
    }
  }
}

async function saveOne(api: MoodleApi, dir: string, p: Placed): Promise<DownloadFile> {
  const notSaved = { ...p.file, url: browserUrl(api.baseUrl, p.moodlePath), localPath: null };
  if (p.file.size !== null && p.file.size > LOCAL_COPY_MAX_BYTES) return notSaved;
  const nodePath = await import('node:path');
  const { rel, complete } = await saveUnique(api, dir, p);
  if (!complete) return notSaved;
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return { ...p.file, path: rel, name, url: null, localPath: nodePath.join(dir, ...rel.split('/')) };
}

interface LocalSave {
  directory: string | null;
  files: DownloadFile[];
  failures: DownloadFailure[];
  /** Folder ZIPs downloaded (each counts as viewing the folder). */
  zipsSaved: number;
}

/** One file after the other (Moodle serialises the session's requests anyway); a failed file fails alone. */
export async function saveAllLocally(api: MoodleApi, placed: Placed[], target: LocalTarget): Promise<LocalSave> {
  const out: LocalSave = { directory: target.dir, files: [], failures: [], zipsSaved: 0 };
  if (placed.length === 0) return out;
  const dir = target.dir ?? (await makeDownloadDir(target.parent));
  out.directory = dir;
  for (const p of placed) {
    try {
      const file = await saveOne(api, dir, p);
      out.files.push(file);
      if (file.zip && file.localPath) out.zipsSaved += 1;
    } catch (e) {
      const reason = p.file.zip && e instanceof NotFound ? ZIP_UNAVAILABLE : failureReason(e);
      out.failures.push({ cmid: p.file.cmid, activity: p.file.activity, file: p.file.path, reason });
    }
  }
  return out;
}
