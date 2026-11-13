/** Validation rules for assignment submissions (window, text, files, statement). */

import { InvalidInput } from '../../errors';
import { fmt, fmtDue, isoJst, toMs } from '../../time';
import type { AssignDetail, FileRef } from '../../types';
import { checkFileList, perFileLimit } from './drafts';
import type { FileInfo } from './inline-files';
import { truncate } from './shared';
import { countWords } from './text';

/** Throws when the assignment cannot be submitted to right now; returns warnings (late, team). */
export function checkSubmissionWindow(a: AssignDetail, now: number): string[] {
  const s = a.submission;
  const warnings: string[] = [];
  if (s.locked) throw new InvalidInput('This submission is locked by the teacher.');
  if (a.opensAt && toMs(a.opensAt) > now) throw new InvalidInput(`Submissions open at ${fmt(a.opensAt)} (JST).`);
  const ext = s.extensionDue ? toMs(s.extensionDue) : null;
  const cutoff = a.cutoffAt ? toMs(a.cutoffAt) : null;
  const extended = ext !== null && now < ext;
  if (cutoff !== null && now > cutoff && !extended) {
    throw new InvalidInput(`Submissions closed at ${fmtDue(a.cutoffAt)} (JST).`);
  }
  if (!s.canEdit) {
    throw new InvalidInput(
      'Moodle does not allow editing this submission right now (it may be closed or already submitted).',
    );
  }
  const due = ext ?? (a.dueAt ? toMs(a.dueAt) : null);
  if (due !== null && now > due) warnings.push(`Late submission: the deadline (${fmtDue(isoJst(due))}) has passed.`);
  if (a.teamSubmission) warnings.push('Team submission: this submits for your whole group.');
  return warnings;
}

export function checkOnlineText(act: AssignDetail, text: string | null): void {
  if (!text) return;
  if (!act.submissionTypes.includes('onlinetext'))
    throw new InvalidInput('This assignment does not accept online text.');
  if (act.wordLimit === null) return;
  const n = countWords(text);
  if (n > act.wordLimit) throw new InvalidInput(`Online text has ${n} words; the limit is ${act.wordLimit}.`);
}

/** Per-file size limit: the assignment's, capped by the service's. */
export function fileSizeLimit(act: AssignDetail): number {
  return perFileLimit(act.maxFileBytes);
}

/** Checks the new files one by one; returns their lower-cased names. */
export function checkNewFiles(act: AssignDetail, files: FileInfo[]): Set<string> {
  if (files.length > 0 && !act.submissionTypes.includes('file')) {
    throw new InvalidInput('This assignment does not accept file submissions.');
  }
  return checkFileList(files, fileSizeLimit(act), act.acceptedTypes);
}

export function checkFileCount(act: AssignDetail, finalCount: number, keptFiles: FileRef[]): void {
  if (act.maxFiles === null || finalCount <= act.maxFiles) return;
  const hint = keptFiles.length ? ' Set keep_existing_files=false to replace the current files.' : '';
  throw new InvalidInput(`Too many files: ${finalCount} (limit ${act.maxFiles}).${hint}`);
}

export function checkSubmittable(act: AssignDetail, hasChange: boolean, submitForGrading: boolean): void {
  if (hasChange) return;
  const canSubmitDraft = act.submission.status === 'draft' && submitForGrading && act.draftsEnabled;
  if (!canSubmitDraft) throw new InvalidInput('Nothing to submit: provide online_text, files or upload_id.');
}

export function checkStatement(act: AssignDetail, submitForGrading: boolean, accepted: boolean | undefined): void {
  const needed = act.requiresStatement && (submitForGrading || !act.draftsEnabled);
  if (!needed || accepted) return;
  const text = act.statement ? ` ("${truncate(act.statement, 300)}")` : '';
  throw new InvalidInput(
    `This assignment requires a submission statement. Show the statement to the user${text} and, only after they accept it, call again with accept_statement=true.`,
  );
}

/** Writing must not leave the submission with neither text nor files (Moodle half-saves and then refuses). */
export function checkResultNotEmpty(
  act: AssignDetail,
  newText: string | null,
  files: { touchesFiles: boolean; finalCount: number },
): void {
  const sub = act.submission;
  const hasText = !!newText || (act.submissionTypes.includes('onlinetext') && !!sub.onlineText?.trim());
  const fileCount = files.touchesFiles ? files.finalCount : sub.files.length;
  if (!hasText && fileCount === 0) {
    throw new InvalidInput('This would leave the submission empty. Keep or add at least one file or some online text.');
  }
}
