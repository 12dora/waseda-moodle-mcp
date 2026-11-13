/**
 * Files staged for a write (assignment submission, forum post): inline files and upload links resolve to one list,
 * are checked against the activity's limits and are uploaded into a Moodle draft area at prepare time.
 */

import type { MoodleApi, ServiceContext, UploadDraftRow } from '../../context';
import { InvalidInput, MoodleError, MoodleUnavailable, NotFound } from '../../errors';
import { formatBytes } from '../../format';
import { nowMs } from '../../time';
import type { FileRef, InlineFile } from '../../types';
import { fileTypeAccepted } from './filenames';
import { type FileInfo, type InlineUpload, resolveInlineFiles } from './inline-files';
import { MAX_FILE_BYTES, num, type Raw } from './shared';

const USED_UPLOAD = 'This upload link was already used or has expired; create a new one.';

export interface StagedFiles {
  uploadRow: UploadDraftRow | null;
  inline: InlineUpload[];
  /** Upload-link files first, then the inline ones. */
  all: FileInfo[];
}

/** Per-file size limit: the activity's (0/null = none), capped by the service's. */
export const perFileLimit = (maxBytes: number | null | undefined): number =>
  maxBytes && maxBytes > 0 ? Math.min(maxBytes, MAX_FILE_BYTES) : MAX_FILE_BYTES;

async function loadUploadRow(ctx: ServiceContext, uploadId: string, cmid: number, what: string) {
  const row = await ctx.store.getUploadDraft(uploadId);
  if (!row || row.userId !== ctx.user.id) throw new NotFound('Upload not found. Create a new upload link.');
  if (row.expiresAt <= nowMs()) throw new InvalidInput(USED_UPLOAD);
  if (row.cmid !== cmid) throw new InvalidInput(`That upload belongs to a different ${what}.`);
  return row;
}

/** Resolves upload_id + inline files for the activity `cmid` (`what` names it in errors). */
export async function gatherFiles(
  ctx: ServiceContext,
  opts: { cmid: number; what: string; files?: InlineFile[]; uploadId?: string; maxBytes: number },
): Promise<StagedFiles> {
  const uploadRow = opts.uploadId ? await loadUploadRow(ctx, opts.uploadId, opts.cmid, opts.what) : null;
  const inline = await resolveInlineFiles(ctx, opts.files ?? [], opts.maxBytes);
  return { uploadRow, inline, all: [...(uploadRow?.files ?? []), ...inline] };
}

/** Unique names, each file within `limit` and of an accepted type; returns the lower-cased names. */
export function checkFileList(files: FileInfo[], limit: number, accepted: string[] = []): Set<string> {
  const names = new Set<string>();
  for (const f of files) {
    const key = f.name.toLowerCase();
    if (names.has(key)) throw new InvalidInput(`Duplicate file name '${f.name}'. Use unique names.`);
    names.add(key);
    if (f.size > limit) {
      throw new InvalidInput(`File '${f.name}' is ${formatBytes(f.size)}; the limit is ${formatBytes(limit)}.`);
    }
    if (!fileTypeAccepted(f.name, accepted)) {
      throw new InvalidInput(`File '${f.name}' is not an accepted type (${accepted.join(', ')}).`);
    }
  }
  return names;
}

/** Retires the upload link so its draft belongs to this action alone. */
export async function claimUpload(ctx: ServiceContext, staged: StagedFiles): Promise<void> {
  if (staged.uploadRow && !(await ctx.store.consumeUploadDraft(staged.uploadRow.id))) {
    throw new InvalidInput(USED_UPLOAD);
  }
}

/** Uploads the inline files into draft `itemId` (null = a new one); returns the draft id (null if nothing ran). */
export async function uploadInline(api: MoodleApi, files: InlineUpload[], itemId: number | null) {
  let id = itemId;
  for (const f of files) {
    const uploaded = await api.uploadToDraft({ name: f.name, body: f.bytes, size: f.size, mime: f.mime }, id ?? 0);
    id = uploaded.itemid;
  }
  return id;
}

/** An empty draft area (saving it clears the files of the target area). */
export async function allocateDraft(api: MoodleApi): Promise<number> {
  const r = await api.call<Raw>('core_files_get_unused_draft_itemid');
  const itemId = num(r?.itemid);
  if (itemId === null || !Number.isInteger(itemId) || itemId <= 0) {
    throw new MoodleError('Moodle did not return a draft area.', 'nodraft');
  }
  return itemId;
}

const isDuplicateUpload = (e: unknown) =>
  e instanceof MoodleError && /exist|duplicate/i.test(`${e.errorcode} ${e.message}`);

/** Streams one of the user's current files into the draft (to keep it); a same-named file already there is fine. */
export async function copyIntoDraft(api: MoodleApi, f: FileRef, itemId: number | null): Promise<number | null> {
  const res = await api.fetchFile(f.url);
  if (!res.ok || !res.body) {
    throw new MoodleUnavailable(`Could not read the current file '${f.name}' to keep it. Try again.`);
  }
  try {
    const uploaded = await api.uploadToDraft({ name: f.name, body: res.body, size: f.size, mime: f.mime }, itemId ?? 0);
    return uploaded.itemid;
  } catch (e) {
    if (isDuplicateUpload(e)) return itemId;
    throw e;
  }
}
