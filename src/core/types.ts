/**
 * Domain types shared by services, MCP tools and the console API.
 *
 * - Every timestamp is an ISO-8601 string with the +09:00 offset (Asia/Tokyo), produced by time.ts.
 * - Text that came from Moodle HTML is converted to Markdown (html.ts) before it lands here.
 * - Optional values are `null`, never omitted, so structuredContent has a stable shape.
 */

import type { ScheduleOverride } from './timetable-types';

export type * from './timetable-types';

export type IsoJst = string;

export type WriteMode = 'off' | 'chat' | 'console';
export type Scope = 'moodle:read' | 'moodle:write';
export type ConnectVia = 'bookmarklet' | 'extension' | 'paste' | 'stdio';
export type UiLang = 'auto' | 'ja' | 'en' | 'zh-CN';

// ------------------------------------------------------------------ user

export interface UserSettings {
  writeMode: WriteMode; // default 'chat'
  myCourseIds: number[] | null; // courses the user attends this term; null = not confirmed → automatic suggestion
  uiLang: UiLang; // default 'auto'
  scheduleOverrides: Record<string, ScheduleOverride>; // by course id; the user's own class times, win over every source
}

export const DEFAULT_SETTINGS: UserSettings = {
  writeMode: 'chat',
  myCourseIds: null,
  uiLang: 'auto',
  scheduleOverrides: {},
};

export interface UserInfo {
  id: number;
  moodleUserId: number;
  fullname: string;
  lang: string;
  settings: UserSettings;
  createdAt: IsoJst;
}

export interface CredentialInfo {
  status: 'active' | 'invalid';
  connectedVia: ConnectVia;
  connectedAt: IsoJst;
  lastOkAt: IsoJst | null;
  lastError: string | null;
  tokenHint: string; // last 4 chars of the token, display only
  /** The token is renewed automatically (a Moodle web session, or a private token to open one). */
  autoRenew: boolean;
  renewedAt: IsoJst | null; // last automatic renewal
}

// ------------------------------------------------------------------ courses

export interface Course {
  id: number;
  name: string; // fullname, HTML entities decoded
  shortName: string;
  category: string | null;
  url: string;
  start: IsoJst | null;
  end: IsoJst | null;
  progress: number | null; // 0-100 when completion tracking is on
  kind: 'class' | 'other'; // 'other' = non-class 提供コンテンツ courses (idnumber contains "ZZ")
  mine: boolean; // in the effective scope (confirmed my courses, or the automatic suggestion)
  suggested: boolean; // the automatic suggestion would include it
  term: string | null; // e.g. "秋クォーター" from the public syllabus when known
  lastAccess: IsoJst | null;
}

export interface FileRef {
  name: string;
  size: number;
  mime: string | null;
  url: string; // Moodle file URL WITHOUT token; pass to get_file
  modified: IsoJst | null;
}

export interface ModuleSummary {
  cmid: number;
  name: string;
  modname: string; // assign, quiz, resource, forum, hsuforum, page, url, folder, questionnaire, millvi, ...
  url: string | null;
  visible: boolean;
  dates: Record<string, IsoJst>; // e.g. { due: ..., opens: ... } from cm `dates` when present
  completed: boolean | null; // null = no completion tracking
  files: FileRef[];
}

export interface Section {
  id: number;
  number: number;
  name: string;
  summary: string; // markdown, may be ""
  modules: ModuleSummary[];
}

export interface CourseOutline {
  course: Course;
  sections: Section[];
}

export interface SearchHit {
  courseId: number;
  courseName: string;
  sectionName: string;
  module: ModuleSummary;
}

// ------------------------------------------------------------------ due items

export type DueKind = 'assign' | 'quiz' | 'questionnaire' | 'forum' | 'lesson' | 'workshop' | 'other';

export interface DueItem {
  kind: DueKind;
  courseId: number;
  courseName: string;
  cmid: number | null;
  name: string; // activity name (not the calendar event title)
  opensAt: IsoJst | null;
  dueAt: IsoJst | null; // null when only an opening time is known
  midnightDue: boolean; // due exactly 00:00 JST -> effectively previous day 24:00
  overdue: boolean;
  closed: boolean; // overdue and Moodle no longer accepts it (past cutoff / not actionable)
  notOpenYet: boolean;
  url: string;
  action: string | null; // Moodle action label
  source: 'calendar' | 'activity' | 'text'; // calendar event / pending activity found by the sweep / deadline mentioned in course text
  evidence: string | null; // text items: snippet around the date (≤160 chars)
  sourceUrl: string | null; // text items: where the mention was found
  isNew: boolean; // first seen by the sweep within the last 72 h
  /** The user's own progress, read live from Moodle; null when not checked (other kinds, or the check failed). */
  submission: DueSubmission | null;
}

/**
 * Where the user stands on an assignment / quiz / questionnaire:
 * - `none`: nothing saved yet; `reopened`: the teacher reopened it for another attempt (assignments);
 * - `draft`: saved but NOT submitted (assignment draft, questionnaire saved to resume) — still has to be submitted;
 * - `in-progress`: a quiz attempt is open and not submitted (in the grace period too) — must be finished;
 * - `submitted`: handed in (assignment submitted, quiz attempt finished, questionnaire answered).
 */
export interface DueSubmission {
  status: 'none' | 'draft' | 'in-progress' | 'submitted' | 'reopened';
  /** Moodle still lets the user change it: edit the submission, continue the attempt, or attempt / answer again. */
  canContinue: boolean;
  submittedAt: IsoJst | null; // when it was handed in, if Moodle says
  graded: boolean;
  /** Short facts for the AI / UI, e.g. "attempt 1 of 2", "submit button not pressed". */
  note: string | null;
}

export interface DueList {
  generatedAt: IsoJst;
  windowFrom: IsoJst;
  windowTo: IsoJst;
  items: DueItem[]; // sorted by dueAt ?? opensAt ascending
  scope: { mode: 'mine' | 'auto'; courseIds: number[]; otherCount: number }; // otherCount = enrolled courses outside the scope
  otherCourses: DueItem[]; // calendar items of enrolled courses outside the scope
  sweep: { checked: number; stale: number; checkedAt: IsoJst | null }; // course-content sweep coverage
  truncated: boolean; // more events existed than the paging budget allowed
}

export interface CourseUpdate {
  courseId: number;
  courseName: string;
  cmid: number;
  name: string;
  modname: string;
  change: 'new' | 'updated';
  what: string[]; // Moodle update areas, e.g. ["contentfiles"]
  at: IsoJst; // when the sweep first noticed it
  url: string;
}

// ------------------------------------------------------------------ activities

export type * from './activity-types';

// ------------------------------------------------------------------ files (passthrough)

export interface FileLink {
  name: string;
  mime: string | null;
  size: number | null;
  downloadUrl: string; // signed, expires; streams the original bytes through the service
  expiresAt: IsoJst;
  inline: { mime: string; base64: string } | { mime: string; text: string } | null; // only for small files when requested
}

export interface UploadLink {
  uploadId: string; // pass to prepare_submission / prepare_forum_post as upload_id
  uploadUrl: string; // signed; PUT/POST raw bytes with ?name=<filename>
  draftItemId: number;
  expiresAt: IsoJst;
  maxBytes: number;
  curlExample: string;
  usedBy: 'prepare_submission' | 'prepare_forum_post'; // the tool that takes the upload_id
}

export interface UploadedDraftFile {
  name: string;
  size: number;
  mime: string | null;
}

// ------------------------------------------------------------------ grades

export interface CourseGrade {
  courseId: number;
  courseName: string;
  grade: string | null;
  raw: number | null;
}

export interface GradeItem {
  name: string;
  itemType: string; // mod, course, category, manual
  modname: string | null;
  cmid: number | null;
  grade: string | null; // formatted
  range: string | null;
  percentage: string | null;
  feedback: string | null; // markdown
  weight: string | null;
  gradedAt: IsoJst | null;
}

export interface CourseGrades {
  courseId: number;
  courseName: string;
  items: GradeItem[];
}

// ------------------------------------------------------------------ forums / messages

export interface DiscussionSummary {
  forumType: 'forum' | 'hsuforum';
  forumId: number;
  forumCmid: number | null;
  forumName: string;
  forumKind: string; // Moodle forum type: news, general, blog, qanda, eachuser, single
  courseId: number;
  courseName: string;
  discussionId: number;
  firstPostId: number;
  subject: string;
  author: string;
  createdAt: IsoJst | null;
  modifiedAt: IsoJst | null;
  replies: number;
  unread: number | null;
  pinned: boolean;
  canCreateDiscussions: boolean;
  dueAt: IsoJst | null;
  cutoffAt: IsoJst | null;
}

/** One forum in a list_discussions result (index + posting flags). */
export interface ForumListEntry {
  forumType: 'forum' | 'hsuforum';
  forumId: number;
  forumCmid: number | null;
  forumName: string;
  forumKind: string;
  courseId: number;
  courseName: string;
  canCreateDiscussions: boolean;
  dueAt: IsoJst | null;
  cutoffAt: IsoJst | null;
  numDiscussions: number | null;
}

/** A forum whose discussions were not all returned. Continue with forum_cmid, nextPage, and the same pageSize as `limit`. */
export interface TruncatedForum {
  forumType: 'forum' | 'hsuforum';
  forumId: number;
  forumCmid: number | null;
  forumName: string;
  remaining: number | null; // null = at least another page, count unknown
  nextPage: number;
  pageSize: number; // `limit` to reuse when paging this forum
}

export interface DiscussionList {
  forums: ForumListEntry[];
  discussions: DiscussionSummary[];
  skippedForums: number;
  truncatedForums: TruncatedForum[];
}

export interface Post {
  id: number;
  parentId: number | null;
  author: string;
  createdAt: IsoJst | null;
  subject: string;
  message: string; // markdown
  attachments: FileRef[];
  unread: boolean;
  canReply: boolean;
}

export interface Discussion {
  summary: DiscussionSummary;
  posts: Post[];
  canReply: boolean;
  forumIntro: string; // markdown, may be ""
}

export interface ConversationSummary {
  id: number;
  name: string; // other member names or group name
  type: 'private' | 'group' | 'self';
  unread: number;
  lastMessage: string | null;
  lastAt: IsoJst | null;
  memberIds: number[];
}

export interface Message {
  id: number;
  author: string;
  fromMe: boolean;
  sentAt: IsoJst;
  text: string; // markdown
}

export interface Conversation {
  summary: ConversationSummary;
  messages: Message[]; // oldest first
}

export interface Notification {
  id: number;
  subject: string;
  text: string; // short markdown
  sender: string | null;
  sentAt: IsoJst;
  read: boolean;
  url: string | null;
  component: string | null;
}

// ------------------------------------------------------------------ write actions

export type ActionKind =
  | 'assign_submit'
  | 'forum_reply'
  | 'forum_discussion'
  | 'message'
  | 'completion'
  | 'mark_read' // notifications, a conversation or a forum discussion marked read
  | 'forum_subscription' // subscribe to / unsubscribe from a forum
  | 'forum_post_edit' // edit one's own forum post
  | 'forum_post_delete' // delete one's own forum post (and its replies)
  | 'questionnaire_submit'; // answer a questionnaire (submit, or save as a draft)
export type ActionStatus = 'pending' | 'executing' | 'executed' | 'cancelled' | 'expired' | 'failed';
/**
 * The one status Store.updateAction may move an action FROM, per target status (pending -> executing is claimAction;
 * executing -> pending hands an action back for a retry). Any other transition loses: exactly one outcome per action.
 */
export const ACTION_STATUS_FROM: Readonly<Partial<Record<ActionStatus, ActionStatus>>> = {
  executed: 'executing',
  failed: 'executing',
  pending: 'executing',
  cancelled: 'pending',
  expired: 'pending',
};
export type Approval = 'chat' | 'console';

export interface InlineFile {
  name: string;
  contentBase64?: string; // exactly one of contentBase64 / text / path
  text?: string;
  path?: string; // stdio (local) mode only: absolute local path
}

export interface ActionPreview {
  actionId: string;
  kind: ActionKind;
  title: string; // one line, e.g. "Submit to 'Report 3' (Strategic Marketing)"
  details: string[]; // human readable lines shown before confirming
  warnings: string[];
  expiresAt: IsoJst;
  approval: Approval; // chat: confirm_action works; console: user approves in the console
  approveUrl: string | null; // set when approval === 'console'
}

export interface ActionRecord {
  id: string;
  kind: ActionKind;
  status: ActionStatus;
  title: string;
  details: string[];
  warnings: string[];
  approval: Approval;
  source: string; // e.g. "Claude", "API key: laptop", "Console"
  createdAt: IsoJst;
  expiresAt: IsoJst;
  executedAt: IsoJst | null;
  result: string | null;
  error: string | null;
}

export interface ActionResult {
  actionId: string;
  status: ActionStatus;
  message: string;
  url: string | null;
}

export type * from './course-overview-types';
export type * from './usage-stats';
