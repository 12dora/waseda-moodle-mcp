/**
 * Bulk download of a course's files (download_course_files): the files of its resources and folders (optionally the
 * files of pages and assignment instructions), placed one directory per section, a chunk of activities per call
 * (`cursor` = the cmid to continue at). The course structure is read once per call (core_course_get_contents).
 *
 * ws: the course contents list every file (no further request; assignments: one course-wide call).
 * web: a resource's file needs its view page (one request each, and Moodle counts it as viewing the resource:
 * viewed, and done where completion is on viewing); a page or an assignment is read through its activity page too; a
 * folder is one ZIP link (`download_folder.php`), no page view at build time (the download is the view).
 * Worker: short-lived signed links (/f/<ticket>); stdio: everything saved into one new local directory.
 */

import type { MoodleApi, ServiceContext } from '../context';
import { InvalidInput, NotFound } from '../errors';
import { isoJst, nowMs } from '../time';
import { sanitizeFileName } from './actions/filenames';
import { auditSafe } from './actions/shared';
import { failureReason, prepareLocalDir, saveAllLocally, withSuffix } from './downloads-local';
import { type Found, type Item, isListedFile, type RawEntry, type Resolved, resolveItem } from './downloads-sources';
import { DOWNLOAD_TTL_SEC, moodleFilePath, signedDownloadUrl } from './files';
import { mapLimit } from './submission/batch';
import { requirePositiveInt } from './validate';

export const DOWNLOAD_KINDS = ['resource', 'folder', 'page', 'assign'] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];
const DEFAULT_KINDS: readonly DownloadKind[] = ['resource', 'folder'];

/** Request units per call (≈ one activity page each) and files per call; the structure costs 2 more on web. */
const CHUNK_UNITS = 30;
const CHUNK_FILES = 40;
const CONCURRENCY = 4;
/** Upper bound of the requests one activity costs on the web channel (an assignment may read up to 3 pages). */
const WEB_UNITS: Record<DownloadKind, number> = { resource: 1, folder: 0, page: 1, assign: 3 };
/** Kinds whose files go into a directory named after the activity (a resource's file sits in the section). */
const OWN_DIR: Record<DownloadKind, boolean> = { resource: false, folder: true, page: true, assign: true };

export interface DownloadFile {
  /** Relative path: `<NN section>/[<activity>/][<sub-folders>/]<name>`. */
  path: string;
  name: string;
  section: number;
  activity: string;
  cmid: number;
  kind: DownloadKind;
  /** Bytes when Moodle lists them; null when unknown. */
  size: number | null;
  /** The folder as one ZIP (web session). */
  zip: boolean;
  /** Worker: the signed download link. stdio: the Moodle address when the file was not saved, else null. */
  url: string | null;
  /** stdio: where the file was saved; null when it was not. */
  localPath: string | null;
}

export interface DownloadFailure {
  cmid: number;
  activity: string;
  /** The file, when one file failed (stdio); absent when the activity could not be read. */
  file?: string;
  reason: string;
}

export interface CourseDownload {
  courseId: number;
  section: number | null;
  kinds: DownloadKind[];
  files: DownloadFile[];
  failures: DownloadFailure[];
  /** Activity pages opened on Moodle (each counted as viewing that activity), by kind. */
  viewed: Partial<Record<DownloadKind, number>>;
  activitiesRead: number;
  /** Activities left after this chunk; continue with nextCursor. */
  remaining: number;
  nextCursor: number | null;
  /** Worker: when the links expire. */
  expiresAt: string | null;
  /** stdio: the local directory. */
  directory: string | null;
}

interface DownloadOptions {
  section?: number;
  kinds?: readonly DownloadKind[];
  cursor?: number;
  /** stdio only: where to create the new directory, or (with cursor) the directory to continue in. */
  destDir?: string;
}

// ------------------------------------------------------------------ course structure

interface RawMod {
  id?: number;
  name?: string;
  modname?: string;
  uservisible?: boolean;
  contents?: RawEntry[] | null;
}

interface RawSec {
  section?: number;
  name?: string;
  uservisible?: boolean;
  modules?: RawMod[] | null;
}

const isKind = (k: unknown, kinds: readonly DownloadKind[]): k is DownloadKind => kinds.some((x) => x === k);

function itemsOf(sec: RawSec, kinds: readonly DownloadKind[]): Item[] {
  if (sec.uservisible === false) return [];
  const section = sec.section ?? 0;
  return (sec.modules ?? []).flatMap((m) => {
    if (!isKind(m.modname, kinds) || m.uservisible === false || !m.id) return [];
    const name = m.name || `${m.modname} ${m.id}`;
    return [{ cmid: m.id, kind: m.modname, name, section, sectionName: sec.name ?? '', contents: m.contents ?? [] }];
  });
}

interface ItemFilter {
  section?: number;
  kinds: readonly DownloadKind[];
}

async function readItems(api: MoodleApi, courseId: number, opts: ItemFilter): Promise<Item[]> {
  const { section } = opts;
  const params: Record<string, unknown> = { courseid: courseId };
  if (section !== undefined) params.options = [{ name: 'sectionnumber', value: section }];
  const raw = await api.call<RawSec[]>('core_course_get_contents', params);
  const sections = (Array.isArray(raw) ? raw : []).filter((s) => section === undefined || s.section === section);
  if (section !== undefined && sections.length === 0) {
    throw new NotFound(`Section ${section} was not found in this course.`);
  }
  return sections.flatMap((s) => itemsOf(s, opts.kinds));
}

function cursorIndex(items: Item[], cursor: number | undefined): number {
  if (cursor === undefined) return 0;
  const at = items.findIndex((i) => i.cmid === cursor);
  if (at < 0) throw new InvalidInput('The cursor does not match this course any more; start again without cursor.');
  return at;
}

/** The activities this call handles: from `start` while the request units and files fit (at least one). */
function takeChunk(api: MoodleApi, items: Item[], start: number): Item[] {
  const web = api.channel === 'web';
  const out: Item[] = [];
  let units = 0;
  let files = 0;
  for (const item of items.slice(start)) {
    const cost = web ? WEB_UNITS[item.kind] : 0;
    const count = web || item.kind === 'assign' ? 1 : item.contents.filter((e) => isListedFile(item, e)).length;
    if (out.length > 0 && (units + cost > CHUNK_UNITS || files + count > CHUNK_FILES)) break;
    out.push(item);
    units += cost;
    files += count;
  }
  return out;
}

// ------------------------------------------------------------------ placing

/** One path segment: no separators, no dot-only names, never empty. */
const segment = (s: string): string => sanitizeFileName(s.replace(/[\\/]/g, '_')) || '_';

function uniquePath(path: string, used: Set<string>): string {
  let out = path;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = withSuffix(path, n);
  used.add(out.toLowerCase());
  return out;
}

const sectionDir = (item: Item) =>
  segment(`${String(item.section).padStart(2, '0')} ${item.sectionName || `Section ${item.section}`}`);

/** A file with its relative path and its download path (moodleFilePath form). */
export interface Placed {
  file: DownloadFile;
  moodlePath: string;
}

function placeFile(baseUrl: string, item: Item, f: Found, used: Set<string>): Placed {
  const moodlePath = moodleFilePath(baseUrl, f.url);
  const dirs = [sectionDir(item)];
  if (OWN_DIR[item.kind] && !f.zip) dirs.push(segment(item.name));
  for (const part of f.subdir.split('/')) if (part) dirs.push(segment(part));
  const name = segment(f.name);
  const path = uniquePath([...dirs, name].join('/'), used);
  const file: DownloadFile = {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    section: item.section,
    activity: item.name,
    cmid: item.cmid,
    kind: item.kind,
    size: f.size,
    zip: f.zip,
    url: null,
    localPath: null,
  };
  return { file, moodlePath };
}

function place(baseUrl: string, chunk: Item[], resolved: Resolved[]) {
  const used = new Set<string>();
  const placed: Placed[] = [];
  const failures: DownloadFailure[] = [];
  chunk.forEach((item, i) => {
    const r = resolved[i] ?? { reason: 'Not read.' };
    if ('reason' in r) {
      failures.push({ cmid: item.cmid, activity: item.name, reason: r.reason });
      return;
    }
    for (const f of r.files) {
      try {
        placed.push(placeFile(baseUrl, item, f, used));
      } catch (e) {
        failures.push({ cmid: item.cmid, activity: item.name, file: f.name, reason: failureReason(e) });
      }
    }
  });
  return { placed, failures };
}

function viewedOnWeb(api: MoodleApi, chunk: Item[]): Partial<Record<DownloadKind, number>> {
  const out: Partial<Record<DownloadKind, number>> = {};
  if (api.channel !== 'web') return out;
  for (const item of chunk) if (WEB_UNITS[item.kind] > 0) out[item.kind] = (out[item.kind] ?? 0) + 1;
  return out;
}

// ------------------------------------------------------------------ entry point

function checkedKinds(kinds: readonly DownloadKind[] | undefined): DownloadKind[] {
  const list = kinds && kinds.length > 0 ? kinds : DEFAULT_KINDS;
  return DOWNLOAD_KINDS.filter((k) => list.includes(k));
}

async function linkAll(ctx: ServiceContext, placed: Placed[]): Promise<DownloadFile[]> {
  return Promise.all(
    placed.map(async (p) => ({ ...p.file, url: await signedDownloadUrl(ctx, p.moodlePath, p.file.name) })),
  );
}

export async function downloadCourseFiles(
  ctx: ServiceContext,
  courseId: number,
  opts: DownloadOptions = {},
): Promise<CourseDownload> {
  requirePositiveInt(courseId, 'course_id');
  const { section, cursor } = opts;
  if (section !== undefined && (!Number.isInteger(section) || section < 0)) {
    throw new InvalidInput('section must be a non-negative integer.');
  }
  const stdio = ctx.mode === 'stdio';
  const local = stdio ? await prepareLocalDir(opts.destDir, cursor !== undefined) : null;
  const kinds = checkedKinds(opts.kinds);
  const api = await ctx.moodle();
  const items = await readItems(api, courseId, { section, kinds });
  const start = cursorIndex(items, cursor);
  const chunk = takeChunk(api, items, start);
  const resolved = await mapLimit(chunk, CONCURRENCY, (item) => resolveItem(api, courseId, item));
  const { placed, failures } = place(api.baseUrl, chunk, resolved);
  const viewed = viewedOnWeb(api, chunk);
  const saved = local ? await saveAllLocally(api, placed, local) : null;
  const files = saved ? saved.files : await linkAll(ctx, placed);
  if (saved?.zipsSaved) viewed.folder = saved.zipsSaved;
  await auditSafe(ctx, 'file:bulk', { courseId, files: files.length });
  return {
    courseId,
    section: section ?? null,
    kinds,
    files,
    failures: [...failures, ...(saved?.failures ?? [])],
    viewed,
    activitiesRead: chunk.length,
    remaining: items.length - start - chunk.length,
    nextCursor: items[start + chunk.length]?.cmid ?? null,
    expiresAt: stdio ? null : isoJst(nowMs() + DOWNLOAD_TTL_SEC * 1000),
    directory: saved?.directory ?? null,
  };
}
