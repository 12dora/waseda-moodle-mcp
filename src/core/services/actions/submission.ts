/** Assignment submission: prepare (validate, stage files in a draft, preview) and execute (save + submit). */

import type { MoodleApi, ServiceContext, UploadDraftRow } from '../../context';
import { InvalidInput, MoodleError, MoodleUnavailable, NeedsReconnect, NotFound } from '../../errors';
import { formatBytes } from '../../format';
import { fmt, nowMs } from '../../time';
import type { ActionPreview, AssignDetail, FileRef, InlineFile } from '../../types';
import { getActivity } from '../activity';
import { type FileInfo, type InlineUpload, resolveInlineFiles } from './inline-files';
import {
  type ActionOutcome,
  assertWriteAllowed,
  hasWarnings,
  isRec,
  num,
  positiveInt,
  type Raw,
  refusal,
  savePreview,
  str,
  truncate,
} from './shared';
import {
  checkFileCount,
  checkNewFiles,
  checkOnlineText,
  checkStatement,
  checkSubmissionWindow,
  checkSubmittable,
  fileSizeLimit,
} from './submission-checks';
import { countWords, markdownToSimpleHtml } from './text';

export interface PrepareSubmissionInput {
  cmid: number;
  onlineText?: string;
  files?: InlineFile[];
  uploadId?: string;
  keepExistingFiles?: boolean;
  submitForGrading?: boolean;
  acceptStatement?: boolean;
}

type SubmitPayload = {
  cmid: number;
  assignId: number;
  assignName: string;
  assignUrl: string;
  draftItemId: number | null;
  onlineText: string | null;
  submitForGrading: boolean;
  draftsEnabled: boolean;
  acceptStatement: boolean;
};

interface FilePlan {
  /** Lower-cased names of the new files (they replace same-named current files). */
  names: Set<string>;
  clearsFiles: boolean;
  touchesFiles: boolean;
  keptFiles: FileRef[];
}

interface Plan extends FilePlan {
  onlineText: string | null;
  keepExisting: boolean;
  submitForGrading: boolean;
  uploadRow: UploadDraftRow | null;
  inlineFiles: InlineUpload[];
  newFiles: FileInfo[];
}

// ------------------------------------------------------------------ prepare

async function loadUploadRow(ctx: ServiceContext, uploadId: string, cmid: number): Promise<UploadDraftRow> {
  const row = await ctx.store.getUploadDraft(uploadId);
  if (!row || row.userId !== ctx.user.id || row.expiresAt <= nowMs()) {
    throw new NotFound('Upload not found or expired. Create a new upload link.');
  }
  if (row.cmid !== cmid) throw new InvalidInput('That upload belongs to a different assignment.');
  return row;
}

function planFiles(act: AssignDetail, newFiles: FileInfo[], keepExisting: boolean): FilePlan {
  const names = checkNewFiles(act, newFiles);
  const existing = act.submission.files;
  const canFile = act.submissionTypes.includes('file');
  const clearsFiles = !keepExisting && newFiles.length === 0 && existing.length > 0 && canFile;
  const touchesFiles = newFiles.length > 0 || clearsFiles;
  const keptFiles =
    touchesFiles && canFile && keepExisting ? existing.filter((f) => !names.has(f.name.toLowerCase())) : [];
  if (touchesFiles) checkFileCount(act, newFiles.length + keptFiles.length, keptFiles);
  return { names, clearsFiles, touchesFiles, keptFiles };
}

async function planSubmission(ctx: ServiceContext, act: AssignDetail, input: PrepareSubmissionInput): Promise<Plan> {
  const onlineText = input.onlineText?.trim() ? input.onlineText : null;
  const keepExisting = input.keepExistingFiles ?? true;
  const submitForGrading = input.submitForGrading ?? true;
  checkOnlineText(act, onlineText);
  const uploadRow = input.uploadId ? await loadUploadRow(ctx, input.uploadId, input.cmid) : null;
  const inlineFiles = await resolveInlineFiles(ctx, input.files ?? [], fileSizeLimit(act));
  const newFiles: FileInfo[] = [...(uploadRow?.files ?? []), ...inlineFiles];
  const files = planFiles(act, newFiles, keepExisting);
  checkSubmittable(act, !!onlineText || files.touchesFiles, submitForGrading);
  checkStatement(act, submitForGrading, input.acceptStatement);
  return { ...files, onlineText, keepExisting, submitForGrading, uploadRow, inlineFiles, newFiles };
}

const isDuplicateUpload = (e: unknown) =>
  e instanceof MoodleError && /exist|duplicate/i.test(`${e.errorcode} ${e.message}`);

/** Streams one of the user's current files into the draft; a same-named file already there is fine. */
async function copyKeptFile(api: MoodleApi, f: FileRef, itemId: number | null): Promise<number | null> {
  const res = await api.fetchFile(f.url);
  if (!res.ok || !res.body)
    throw new MoodleUnavailable('Could not read your current submission file to keep it. Try again.');
  try {
    const uploaded = await api.uploadToDraft({ name: f.name, body: res.body, size: f.size, mime: f.mime }, itemId ?? 0);
    return uploaded.itemid;
  } catch (e) {
    if (isDuplicateUpload(e)) return itemId;
    throw e;
  }
}

async function allocateDraft(api: MoodleApi): Promise<number> {
  const r = await api.call<Raw>('core_files_get_unused_draft_itemid');
  const itemId = num(r.itemid);
  if (itemId === null) throw new MoodleError('Moodle did not return a draft area.', 'nodraft');
  return itemId;
}

/** Uploads at prepare time so confirm is fast. Returns the draft item id the save should reference. */
async function stageDraft(ctx: ServiceContext, plan: Plan): Promise<number | null> {
  const api = await ctx.moodle();
  let itemId = plan.uploadRow?.draftItemId ?? null;
  for (const f of plan.inlineFiles) {
    const uploaded = await api.uploadToDraft({ name: f.name, body: f.bytes, size: f.size, mime: f.mime }, itemId ?? 0);
    itemId = uploaded.itemid;
    if (plan.uploadRow) {
      await ctx.store.appendUploadedFile(plan.uploadRow.id, { name: f.name, size: f.size, mime: f.mime });
    }
  }
  if (plan.newFiles.length > 0) {
    const have = new Set((plan.uploadRow?.files ?? []).map((f) => f.name.toLowerCase()));
    for (const f of plan.keptFiles) {
      if (!have.has(f.name.toLowerCase())) itemId = await copyKeptFile(api, f, itemId);
    }
  } else if (plan.clearsFiles) {
    itemId = await allocateDraft(api);
  }
  return plan.touchesFiles ? itemId : null;
}

function gradingLabel(draftsEnabled: boolean, submit: boolean): string {
  if (!draftsEnabled) return 'yes (saving submits immediately)';
  return submit ? 'yes' : 'no (stays a draft)';
}

function previewDetails(act: AssignDetail, plan: Plan): string[] {
  const ext = act.submission.extensionDue;
  const details = [
    `Assignment: ${act.name} (${act.courseName})`,
    `Due: ${fmt(ext ?? act.dueAt)}${ext ? ' (extended)' : ''}`,
  ];
  for (const f of plan.newFiles) details.push(`File: ${f.name} (${formatBytes(f.size)})`);
  for (const f of plan.keptFiles) details.push(`Kept from current submission: ${f.name} (${formatBytes(f.size)})`);
  if (plan.onlineText) {
    const excerpt = truncate(plan.onlineText.replace(/\s+/g, ' ').trim(), 200);
    details.push(`Online text (${countWords(plan.onlineText)} words): ${excerpt}`);
  }
  details.push(`Submit for grading: ${gradingLabel(act.draftsEnabled, plan.submitForGrading)}`);
  if (act.requiresStatement && act.statement) details.push(`Submission statement (accepted by user): ${act.statement}`);
  return details;
}

function sameNameWarnings(existing: FileRef[], plan: Plan): string[] {
  if (!plan.keepExisting) return [];
  return existing
    .filter((f) => plan.names.has(f.name.toLowerCase()))
    .map((f) => `'${f.name}' replaces the current file with the same name.`);
}

function draftWarnings(act: AssignDetail, submitForGrading: boolean): string[] {
  if (submitForGrading) return [];
  return [
    act.draftsEnabled
      ? 'It will stay a draft until it is submitted for grading.'
      : 'This assignment has no draft stage: saving submits it immediately.',
  ];
}

function previewWarnings(act: AssignDetail, plan: Plan, base: string[]): string[] {
  const sub = act.submission;
  const warnings = [...base];
  const replacesFiles = sub.files.length > 0 && plan.touchesFiles && !plan.keepExisting;
  if (sub.status === 'submitted') warnings.push('You already submitted; this replaces the current submission.');
  else if (replacesFiles) warnings.push(`Replaces the ${sub.files.length} file(s) in the current submission.`);
  warnings.push(...sameNameWarnings(sub.files, plan));
  if (plan.clearsFiles) warnings.push('Removes all files from the current submission.');
  if (plan.onlineText && sub.onlineText?.trim()) warnings.push('Overwrites the current online text.');
  warnings.push(...draftWarnings(act, plan.submitForGrading));
  return warnings;
}

export async function prepareSubmission(ctx: ServiceContext, input: PrepareSubmissionInput): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  const cmid = positiveInt(input.cmid, 'cmid');
  const act = await getActivity(ctx, cmid);
  if (act.type !== 'assign') {
    throw new InvalidInput('This activity is not an assignment, so nothing can be submitted to it.');
  }
  const windowWarnings = checkSubmissionWindow(act, nowMs());
  const plan = await planSubmission(ctx, act, { ...input, cmid });
  const draftItemId = await stageDraft(ctx, plan);
  const payload: SubmitPayload = {
    cmid,
    assignId: act.instanceId,
    assignName: act.name,
    assignUrl: act.url,
    draftItemId,
    onlineText: plan.onlineText,
    submitForGrading: plan.submitForGrading,
    draftsEnabled: act.draftsEnabled,
    acceptStatement: !act.requiresStatement || input.acceptStatement === true,
  };
  return savePreview(ctx, {
    kind: 'assign_submit',
    title: `Submit to '${act.name}' (${act.courseName})`,
    details: previewDetails(act, plan),
    warnings: previewWarnings(act, plan, windowWarnings),
    payload,
  });
}

// ------------------------------------------------------------------ execute

function submissionNode(status: Raw): Raw | null {
  const last = isRec(status.lastattempt) ? status.lastattempt : null;
  if (!last) return null;
  if (isRec(last.teamsubmission)) return last.teamsubmission;
  return isRec(last.submission) ? last.submission : null;
}

async function readStatus(api: MoodleApi, assignId: number): Promise<string | null> {
  try {
    const st = await api.call<Raw>('mod_assign_get_submission_status', {
      assignid: assignId,
      userid: api.moodleUserId,
    });
    return str(submissionNode(st)?.status);
  } catch (e) {
    if (e instanceof NeedsReconnect) throw e;
    return null;
  }
}

function statusMessage(status: string | null): string {
  if (status === 'submitted') return 'Submitted. Status: submitted.';
  if (!status) return 'Saved.';
  return `Saved. Status: ${status}${status === 'draft' ? ' (not yet submitted for grading)' : ''}.`;
}

async function saveSubmission(api: MoodleApi, p: SubmitPayload): Promise<void> {
  const plugindata: Raw = {};
  if (p.onlineText) plugindata.onlinetext_editor = { text: markdownToSimpleHtml(p.onlineText), format: 1, itemid: 0 };
  if (p.draftItemId !== null) plugindata.files_filemanager = p.draftItemId;
  const saved = await api.call<unknown>('mod_assign_save_submission', { assignmentid: p.assignId, plugindata });
  if (hasWarnings(saved)) throw refusal('refused the submission', saved);
}

export async function executeSubmission(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as SubmitPayload;
  if (p.onlineText || p.draftItemId !== null) await saveSubmission(api, p);
  if (p.submitForGrading && p.draftsEnabled) {
    const sent = await api.call<unknown>('mod_assign_submit_for_grading', {
      assignmentid: p.assignId,
      acceptsubmissionstatement: p.acceptStatement,
    });
    if (hasWarnings(sent)) throw refusal('refused to submit it for grading', sent, 'Saved, but ');
  }
  return { message: statusMessage(await readStatus(api, p.assignId)), url: p.assignUrl };
}
