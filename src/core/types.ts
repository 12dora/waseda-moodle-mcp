/**
 * Domain types shared by services, MCP tools and the console API.
 *
 * - Every timestamp is an ISO-8601 string with the +09:00 offset (Asia/Tokyo), produced by time.ts.
 * - Text that came from Moodle HTML is converted to Markdown (html.ts) before it lands here.
 * - Optional values are `null`, never omitted, so structuredContent has a stable shape.
 */

export type IsoJst = string;

export type WriteMode = 'off' | 'chat' | 'console';
export type Scope = 'moodle:read' | 'moodle:write';
export type ConnectVia = 'bookmarklet' | 'extension' | 'paste' | 'stdio';
export type UiLang = 'auto' | 'ja' | 'en' | 'zh-CN';

// ------------------------------------------------------------------ user

export interface UserSettings {
  writeMode: WriteMode; // default 'chat'
  hiddenCourseIds: number[]; // default []
  uiLang: UiLang; // default 'auto'
}

export const DEFAULT_SETTINGS: UserSettings = { writeMode: 'chat', hiddenCourseIds: [], uiLang: 'auto' };

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
  hidden: boolean; // hidden by the user in settings
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
}

export interface DueList {
  generatedAt: IsoJst;
  windowFrom: IsoJst;
  windowTo: IsoJst;
  items: DueItem[]; // sorted by dueAt ?? opensAt ascending
  hiddenCourseCount: number; // items dropped because the course is hidden
  truncated: boolean; // more events existed than the paging budget allowed
}

// ------------------------------------------------------------------ activities

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
  draftsEnabled: boolean; // submissiondrafts
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

export type ActivityDetail = AssignDetail | QuizDetail | ContentDetail | ForumDetail;

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
  uploadId: string; // pass to prepare_submission as upload_id
  uploadUrl: string; // signed; PUT/POST raw bytes with ?name=<filename>
  draftItemId: number;
  expiresAt: IsoJst;
  maxBytes: number;
  curlExample: string;
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
}

export interface Post {
  id: number;
  parentId: number | null;
  author: string;
  createdAt: IsoJst | null;
  subject: string;
  message: string; // markdown
  attachments: FileRef[];
}

export interface Discussion {
  summary: DiscussionSummary;
  posts: Post[];
  canReply: boolean;
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

export type ActionKind = 'assign_submit' | 'forum_reply' | 'forum_discussion' | 'message' | 'completion';
export type ActionStatus = 'pending' | 'executed' | 'cancelled' | 'expired' | 'failed';
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
