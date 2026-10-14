import { formatBytes } from '../../format';
import { fmt } from '../../time';
import type { AssignDetail, Feedback, SubmissionState } from '../../types';
import { clip, fileLines, hardCap, MAX_TEXT_CHARS, oneLine } from './common';

function acceptsLine(a: AssignDetail): string {
  const accepts: string[] = [];
  if (a.submissionTypes.includes('onlinetext')) {
    accepts.push(`online text${a.wordLimit ? ` (max ${a.wordLimit} words)` : ''}`);
  }
  if (a.submissionTypes.includes('file')) {
    const limits = [
      a.maxFiles ? `up to ${a.maxFiles} files` : null,
      a.maxFileBytes ? `${formatBytes(a.maxFileBytes)} each` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const types = a.acceptedTypes.length ? `; types ${a.acceptedTypes.join(' ')}` : '';
    accepts.push(`file upload${limits || types ? ` (${limits}${types})` : ''}`);
  }
  const team = a.teamSubmission ? ' · team submission' : '';
  return `Accepts: ${accepts.join(' + ') || 'no online submission'}${team}`;
}

function editability(s: SubmissionState): string {
  if (s.locked) return ' · locked';
  return s.canEdit ? ' · editable' : ' · not editable';
}

function statusLine(a: AssignDetail): string {
  const s = a.submission;
  let status = `Your submission: ${s.status}`;
  if (s.gradingStatus) status += ` (grading: ${s.gradingStatus})`;
  if (s.lastModified) status += `, last modified ${fmt(s.lastModified)}`;
  status += editability(s);
  if (s.extensionDue) status += ` · extension until ${fmt(s.extensionDue)}`;
  if (a.draftsEnabled) status += ' · drafts must be submitted for grading';
  return status;
}

function submissionLines(s: SubmissionState): string[] {
  const lines: string[] = [];
  if (s.files.length > 0) lines.push('Submitted files:', ...fileLines(s.files, 5));
  if (s.onlineText) lines.push(`Submitted text: ${oneLine(s.onlineText, 300)}`);
  return lines;
}

function feedbackLines(fb: Feedback): string[] {
  const lines = [`Feedback: grade ${fb.grade ?? '-'}${fb.gradedAt ? ` (${fmt(fb.gradedAt)})` : ''}`];
  if (fb.comments) lines.push(oneLine(fb.comments, 500));
  if (fb.files.length > 0) lines.push(...fileLines(fb.files, 4));
  return lines;
}

export function assignText(a: AssignDetail): string {
  const lines = [
    `# ${oneLine(a.name, 100)} — assignment (cmid ${a.cmid})`,
    `Course: ${oneLine(a.courseName, 80)} (course_id ${a.courseId})`,
    `Link: ${a.url}`,
    `Opens: ${fmt(a.opensAt)} · Due: ${fmt(a.dueAt)} · Cut-off: ${fmt(a.cutoffAt)}`,
    acceptsLine(a),
    statusLine(a),
    ...submissionLines(a.submission),
  ];
  if (a.requiresStatement) {
    lines.push(`Submission statement (the user must accept it): ${oneLine(a.statement ?? '', 400)}`);
  }
  if (a.feedback) lines.push(...feedbackLines(a.feedback));
  if (a.attachments.length > 0) lines.push('Attachments:', ...fileLines(a.attachments, 8));

  const room = Math.max(500, MAX_TEXT_CHARS - lines.join('\n').length - 120);
  if (a.description.trim()) lines.push('', '## Instructions', clip(a.description, room));
  return hardCap(lines.join('\n'));
}
