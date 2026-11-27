/** Activity detail shapes (get_activity): one per module type, plus the shared submission and feedback parts. */

import type { DiscussionSummary, FileRef, IsoJst } from './types';

export interface SubmissionState {
  status: 'new' | 'draft' | 'submitted' | 'reopened' | 'none';
  gradingStatus: string | null;
  lastModified: IsoJst | null;
  onlineText: string | null; // markdown
  files: FileRef[];
  canEdit: boolean;
  canSubmit: boolean;
  locked: boolean;
  extensionDue: IsoJst | null;
}

export interface Feedback {
  grade: string | null; // gradefordisplay
  gradedAt: IsoJst | null;
  comments: string | null; // markdown
  files: FileRef[];
}

export interface AssignDetail {
  type: 'assign';
  cmid: number;
  instanceId: number;
  courseId: number;
  courseName: string;
  name: string;
  url: string;
  description: string; // markdown (intro + activity instructions)
  attachments: FileRef[];
  opensAt: IsoJst | null;
  dueAt: IsoJst | null;
  cutoffAt: IsoJst | null;
  submissionTypes: Array<'onlinetext' | 'file'>;
  maxFiles: number | null;
  maxFileBytes: number | null;
  acceptedTypes: string[]; // e.g. [".pdf", ".docx"]; [] = any
  wordLimit: number | null;
  draftsEnabled: boolean | null; // submissiondrafts; null = not shown (web channel, new attempt)
  requiresStatement: boolean;
  statement: string | null;
  teamSubmission: boolean;
  submission: SubmissionState;
  feedback: Feedback | null;
}

export interface QuizAttempt {
  attempt: number;
  state: string; // inprogress, overdue, finished, abandoned
  startedAt: IsoJst | null;
  finishedAt: IsoJst | null;
  grade: string | null;
}

export interface QuizDetail {
  type: 'quiz';
  cmid: number;
  instanceId: number;
  courseId: number;
  courseName: string;
  name: string;
  url: string;
  description: string;
  opensAt: IsoJst | null;
  closesAt: IsoJst | null;
  timeLimitMinutes: number | null;
  attemptsAllowed: number | null; // null = unlimited
  attempts: QuizAttempt[];
  bestGrade: string | null;
}

/** resource, folder, page, url, label, book and any other module. */
export interface ContentDetail {
  type: 'content';
  cmid: number;
  courseId: number;
  courseName: string;
  name: string;
  modname: string;
  url: string;
  description: string;
  body: string | null; // markdown for page/label/book; null otherwise
  externalUrl: string | null; // mod_url target
  files: FileRef[];
}

export interface ForumDetail {
  type: 'forum';
  cmid: number;
  forumId: number;
  forumType: 'forum' | 'hsuforum';
  courseId: number;
  courseName: string;
  name: string;
  url: string;
  description: string;
  dueAt: IsoJst | null;
  discussions: DiscussionSummary[]; // most recent first, max 10
}

/** Student view of an attendance activity (mobile summary; this site has no self check-in). */
export interface AttendanceSummary {
  takenSessions: number | null;
  points: string | null; // of taken sessions, e.g. "12 / 18"
  percentage: string | null; // of taken sessions, e.g. "66.7%"
  totalSessions: number | null;
  maxPossiblePoints: string | null; // e.g. "24 / 30"
  maxPossiblePercentage: string | null; // e.g. "80.0%"
}

export interface AttendanceSession {
  at: IsoJst | null; // session start; null if the printed date could not be parsed
  time: string; // as printed (date + start–end)
  group: string | null;
  acronym: string | null; // P, A, L, … when the status text is a short code
  status: string | null; // description ("Present", …)
  remarks: string | null;
}

export interface AttendanceDetail {
  type: 'attendance';
  cmid: number;
  instanceId: number;
  courseId: number;
  courseName: string;
  name: string;
  url: string;
  description: string;
  summary: AttendanceSummary;
  sessions: AttendanceSession[]; // most recent first, max 20
  complete: boolean; // false when the HTML was too large to read in full
}

export type QuestionnaireQuestionType =
  | 'yesno'
  | 'text'
  | 'essay'
  | 'radio'
  | 'checkbox'
  | 'dropdown'
  | 'rate'
  | 'date'
  | 'numeric'
  | 'slider'
  | 'other';

export interface QuestionnaireChoice {
  id: string; // choice id (radio, checkbox, dropdown, rate row) or "1" / "0" (yes / no)
  label: string;
  otherText: boolean; // an "other" choice with its own text field
}

export interface QuestionnaireQuestion {
  id: number;
  page: number; // 1-based
  number: string | null; // as numbered in Moodle
  type: QuestionnaireQuestionType;
  required: boolean;
  prompt: string; // markdown
  choices: QuestionnaireChoice[]; // options, or the rows of a rating scale
  scale: Array<{ value: string; label: string }>; // rating scale: the values every row takes
  range: { min: number; max: number; step: number } | null; // slider
  answer: string | null; // the user's answer in plain words (submitted or saved draft)
}

export interface QuestionnaireDetail {
  type: 'questionnaire';
  cmid: number;
  courseId: number;
  courseName: string;
  name: string;
  url: string;
  description: string;
  opensAt: IsoJst | null;
  closesAt: IsoJst | null;
  window: 'open' | 'not-open' | 'closed';
  status: 'none' | 'draft' | 'submitted';
  submittedAt: IsoJst | null;
  submissions: number; // completed responses Moodle lists for the user
  canAnswer: boolean; // Moodle offers answering (or resuming the draft) now
  notice: string | null; // Moodle's own notice, e.g. why it cannot be answered
  answers: 'draft' | 'submitted' | null; // whose answers `questions[].answer` carries
  questions: QuestionnaireQuestion[];
  complete: boolean; // false when some pages could not be read
}

export type ActivityDetail =
  | AssignDetail
  | QuizDetail
  | ContentDetail
  | ForumDetail
  | AttendanceDetail
  | QuestionnaireDetail;
