/** Assignment submission: prepare (validate, stage files in a draft, preview) and execute (save + submit). */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput } from '../../errors';
import { formatBytes } from '../../format';
import { fmtDue, nowMs } from '../../time';
import type { ActionPreview, AssignDetail, FileRef, InlineFile } from '../../types';
import { getActivity } from '../activity';
import { allocateDraft, claimUpload, copyIntoDraft, gatherFiles, type StagedFiles, uploadInline } from './drafts';
import { unverifiableTypes } from './filenames';
import type { FileInfo } from './inline-files';
import {
  type ActionOutcome,
  assertWriteAllowed,
  hasWarnings,
  isRec,
  num,
  positiveInt,
  previewText,
  type Raw,
  refusal,
  savePreview,
  str,
} from './shared';
import {
  checkFileCount,
  checkNewFiles,
  checkOnlineText,
  checkResultNotEmpty,
  checkStatement,
  checkSubmissionWindow,
  checkSubmittable,
  fileSizeLimit,
} from './submission-checks';
import { countCjkChars, countWords, markdownToSimpleHtml } from './text';

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
  /** Draft area holding exactly the files to save; null = files untouched. */
  draftItemId: number | null;
  /** Number of files in that draft (0 when the submission's files are being cleared). */
  draftFileCount: number;
  onlineText: string | null;
  /** The assignment takes online text: it must be sent along with every save or Moodle blanks it. */
  textPluginEnabled: boolean;
  submitForGrading: boolean;
  /** null: Moodle did not show whether the assignment has a draft stage (the save may submit at once). */
  draftsEnabled: boolean | null;
  /** The user accepted the statement the preview showed them (false when none was shown). */
  acceptStatement: boolean;
};

interface FilePlan {
  /** Lower-cased names of the new files (they replace same-named current files). */
  names: Set<string>;
  clearsFiles: boolean;
  touchesFiles: boolean;
  keptFiles: FileRef[];
  /** Files in the submission after this action (when touched). */
  finalCount: number;
}

interface Plan extends FilePlan {
  onlineText: string | null;
  keepExisting: boolean;
  submitForGrading: boolean;
  staged: StagedFiles;
  newFiles: FileInfo[];
}

// ------------------------------------------------------------------ prepare

function planFiles(act: AssignDetail, newFiles: FileInfo[], keepExisting: boolean): FilePlan {
  const names = checkNewFiles(act, newFiles);
  const existing = act.submission.files;
  const canFile = act.submissionTypes.includes('file');
  const clearsFiles = !keepExisting && newFiles.length === 0 && existing.length > 0 && canFile;
  const touchesFiles = newFiles.length > 0 || clearsFiles;
  const keptFiles =
    touchesFiles && canFile && keepExisting ? existing.filter((f) => !names.has(f.name.toLowerCase())) : [];
  const finalCount = newFiles.length + keptFiles.length;
  if (touchesFiles) checkFileCount(act, finalCount, keptFiles);
  return { names, clearsFiles, touchesFiles, keptFiles, finalCount };
}

async function planSubmission(ctx: ServiceContext, act: AssignDetail, input: PrepareSubmissionInput): Promise<Plan> {
  const onlineText = input.onlineText?.trim() ? input.onlineText : null;
  const keepExisting = input.keepExistingFiles ?? true;
  const submitForGrading = input.submitForGrading ?? true;
  checkOnlineText(act, onlineText);
  const staged = await gatherFiles(ctx, {
    cmid: input.cmid,
    what: 'assignment',
    files: input.files,
    uploadId: input.uploadId,
    maxBytes: fileSizeLimit(act),
  });
  const newFiles = staged.all;
  const files = planFiles(act, newFiles, keepExisting);
  const hasChange = !!onlineText || files.touchesFiles;
  checkSubmittable(act, hasChange, submitForGrading);
  if (hasChange) checkResultNotEmpty(act, onlineText, files);
  checkStatement(act, submitForGrading, input.acceptStatement);
  return { ...files, onlineText, keepExisting, submitForGrading, staged, newFiles };
}

/** Uploads at prepare time so confirm is fast. Returns the draft item id the save should reference. */
async function stageDraft(ctx: ServiceContext, plan: Plan, cmid: number): Promise<number | null> {
  const api = await ctx.moodle();
  let itemId = await uploadInline(api, plan.staged.inline, plan.staged.uploadRow?.draftItemId ?? null, cmid);
  if (plan.newFiles.length > 0) {
    const have = new Set((plan.staged.uploadRow?.files ?? []).map((f) => f.name.toLowerCase()));
    for (const f of plan.keptFiles) {
      if (!have.has(f.name.toLowerCase())) itemId = await copyIntoDraft(api, f, itemId, cmid);
    }
  } else if (plan.clearsFiles) {
    itemId = await allocateDraft(api);
  }
  return plan.touchesFiles ? itemId : null;
}

const MAY_SUBMIT = 'Moodle does not show whether this assignment has a draft stage: saving may submit it at once.';

function gradingLabel(draftsEnabled: boolean | null, submit: boolean): string {
  if (draftsEnabled === false) return 'yes (saving submits immediately)';
  if (submit) return 'yes';
  return draftsEnabled ? 'no (stays a draft)' : 'no, if Moodle keeps drafts (saving may submit it at once)';
}

function previewDetails(act: AssignDetail, plan: Plan): string[] {
  const ext = act.submission.extensionDue;
  const details = [
    `Assignment: ${act.name} (${act.courseName})`,
    `Due: ${fmtDue(ext ?? act.dueAt)}${ext ? ' (extended)' : ''}`,
  ];
  for (const f of plan.newFiles) {
    details.push(`File: ${f.name} (${formatBytes(f.size)})${f.source ? ` — from ${f.source}` : ''}`);
  }
  for (const f of plan.keptFiles) details.push(`Kept from current submission: ${f.name} (${formatBytes(f.size)})`);
  if (plan.onlineText) {
    const cjk = countCjkChars(plan.onlineText);
    const count = `${countWords(plan.onlineText)} words${cjk ? `, ${cjk} CJK characters` : ''}`;
    details.push(`Online text (${count}): ${previewText(plan.onlineText)}`);
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
  if (act.draftsEnabled === null) return [MAY_SUBMIT];
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
  const unverified = plan.newFiles.length > 0 ? unverifiableTypes(act.acceptedTypes) : [];
  if (unverified.length)
    warnings.push(`File types (${unverified.join(', ')}) could not be checked here; Moodle will check them.`);
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
  await claimUpload(ctx, plan.staged);
  const draftItemId = await stageDraft(ctx, plan, cmid);
  const payload: SubmitPayload = {
    cmid,
    assignId: act.instanceId,
    assignName: act.name,
    assignUrl: act.url,
    draftItemId,
    draftFileCount: plan.finalCount,
    onlineText: plan.onlineText,
    textPluginEnabled: act.submissionTypes.includes('onlinetext'),
    submitForGrading: plan.submitForGrading,
    draftsEnabled: act.draftsEnabled,
    // only a statement the preview showed can be accepted; one Moodle shows later (on the submit form) is refused
    acceptStatement: act.requiresStatement && input.acceptStatement === true,
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

async function readSubmission(api: MoodleApi, assignId: number, fresh: boolean): Promise<Raw | null> {
  // The client memoises reads per request; an extra (default) param makes the post-write read really fresh.
  const params = { assignid: assignId, userid: api.moodleUserId, ...(fresh ? { groupid: 0 } : {}) };
  return submissionNode(await api.call<Raw>('mod_assign_get_submission_status', params));
}

/** Status after the write; the write already happened, so a failing re-read never fails the action. */
async function readStatus(api: MoodleApi, assignId: number): Promise<string | null> {
  try {
    return str((await readSubmission(api, assignId, true))?.status);
  } catch {
    return null;
  }
}

/** The raw online text (HTML + format) currently stored in the user's submission. */
function currentOnlineText(submission: Raw | null): { text: string; format: number } {
  const plugins = submission && Array.isArray(submission.plugins) ? submission.plugins : [];
  const plugin = plugins.find((pl): pl is Raw => isRec(pl) && pl.type === 'onlinetext');
  const fields = plugin && Array.isArray(plugin.editorfields) ? plugin.editorfields : [];
  const field = fields.find((f): f is Raw => isRec(f) && f.name === 'onlinetext');
  return { text: str(field?.text) ?? '', format: num(field?.format) ?? 1 };
}

/**
 * onlinetext_editor for the save, or null when the assignment takes no online text. A web-service save without it
 * blanks the text, so a files-only submission sends the current text back unchanged. The web channel posts the edit
 * form, which already holds the stored text: echoing the (filtered) text of the status page would alter it.
 */
async function onlineTextEditor(api: MoodleApi, p: SubmitPayload): Promise<Raw | null> {
  if (p.onlineText) return { text: markdownToSimpleHtml(p.onlineText), format: 1, itemid: 0 };
  if (!p.textPluginEnabled || api.channel === 'web') return null;
  return { ...currentOnlineText(await readSubmission(api, p.assignId, false)), itemid: 0 };
}

function statusMessage(status: string | null): string {
  if (status === 'submitted') return 'Submitted. Status: submitted.';
  if (!status) return 'Saved.';
  return `Saved. Status: ${status}${status === 'draft' ? ' (not yet submitted for grading)' : ''}.`;
}

/** Everything is checked before the first write, so a refusal never leaves a half-saved submission. */
async function saveSubmission(api: MoodleApi, p: SubmitPayload): Promise<void> {
  const editor = await onlineTextEditor(api, p);
  const hasText = typeof editor?.text === 'string' && editor.text.trim() !== '';
  // web: the form keeps the stored text when none is sent (prepare checked the result is not empty)
  const keepsText = api.channel === 'web' && p.textPluginEnabled && !editor;
  if (p.draftItemId !== null && p.draftFileCount === 0 && !hasText && !keepsText) {
    throw new InvalidInput('This would leave the submission empty. Keep or add at least one file or some online text.');
  }
  const plugindata: Raw = {};
  if (editor) plugindata.onlinetext_editor = editor;
  if (p.draftItemId !== null) plugindata.files_filemanager = p.draftItemId;
  const params: Raw = { assignmentid: p.assignId, plugindata };
  // the web form asks for the statement on the save when the assignment has no draft stage (the web service has no
  // such parameter and refuses unknown ones)
  if (api.channel === 'web') params.acceptsubmissionstatement = p.acceptStatement;
  const saved = await api.call<unknown>('mod_assign_save_submission', params);
  if (hasWarnings(saved)) throw refusal('refused the submission', saved);
}

/**
 * Submits for grading only what is still a draft after the save: without a draft stage the save already submitted
 * it (success, not a refusal). An unreadable status falls back to the known setting.
 */
function needsSubmit(p: SubmitPayload, status: string | null): boolean {
  if (!p.submitForGrading) return false;
  return status === null ? p.draftsEnabled === true : status === 'draft';
}

/** The web channel's refusal for a statement the user was not shown (it is on the submit form only). */
const statementRefused = (res: unknown): boolean =>
  Array.isArray(res) && res.some((w) => isRec(w) && w.warningcode === 'submissionstatementrequired');

const STATEMENT_NEXT =
  ' Show the statement to the user and, only after they accept it, prepare the submission again with' +
  ' accept_statement=true.';

async function submitDraft(api: MoodleApi, p: SubmitPayload, saved: boolean): Promise<void> {
  const sent = await api.call<unknown>('mod_assign_submit_for_grading', {
    assignmentid: p.assignId,
    acceptsubmissionstatement: p.acceptStatement,
  });
  if (!hasWarnings(sent)) return;
  const err = refusal('refused to submit it for grading', sent, saved ? 'Saved as a draft, but ' : '');
  if (statementRefused(sent)) throw new InvalidInput(`${err.message}${STATEMENT_NEXT}`);
  throw err;
}

export async function executeSubmission(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as SubmitPayload;
  const saves = !!p.onlineText || p.draftItemId !== null;
  if (saves) await saveSubmission(api, p);
  let status = await readStatus(api, p.assignId);
  if (needsSubmit(p, status)) {
    await submitDraft(api, p, saves);
    status = await readStatus(api, p.assignId);
  }
  return { message: statusMessage(status), url: p.assignUrl };
}
