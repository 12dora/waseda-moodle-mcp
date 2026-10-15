/**
 * Synthetic structuredContent payloads, one realistic and one empty/null-heavy variant per tool, typed with the real
 * domain types so a drifting type fails the compiler before it fails a client. Names, ids and texts are invented.
 */
import type { ForumSearchResult } from '../../src/core/services/forums-search';
import type { GradesResult } from '../../src/core/services/grades';
import type { ConversationPage } from '../../src/core/services/messages';
import type { NotificationPage } from '../../src/core/services/messages/notifications';
import type { PeopleResult } from '../../src/core/services/messages/people';
import type { QuizReview } from '../../src/core/services/quiz-review';
import type { SyllabusDetails } from '../../src/core/services/syllabus-details';
import { parseSyllabusPage } from '../../src/core/services/syllabus-page';
import type {
  ActionPreview,
  ActionResult,
  ActivityDetail,
  Course,
  CourseOutline,
  CourseUpdate,
  Discussion,
  DiscussionSummary,
  DueItem,
  DueList,
  FileLink,
  ModuleSummary,
  ScheduleOverride,
  Timetable,
  UploadLink,
  UserSettings,
} from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import { JA_PAGE } from './syllabus';

const AT = '2026-10-14T12:00:00+09:00';
const BASE = 'https://moodle.example.edu';

const course: Course = {
  id: 101,
  name: 'Finance',
  shortName: 'F',
  category: null,
  url: `${BASE}/course/view.php?id=101`,
  start: null,
  end: null,
  progress: null,
  kind: 'class',
  mine: true,
  suggested: true,
  term: null,
  lastAccess: null,
};

const dueItem: DueItem = {
  kind: 'assign',
  courseId: 101,
  courseName: 'Finance',
  cmid: 5001,
  name: 'Report 3',
  opensAt: null,
  dueAt: AT,
  midnightDue: false,
  overdue: false,
  closed: false,
  notOpenYet: false,
  url: `${BASE}/mod/assign/view.php?id=5001`,
  action: null,
  source: 'calendar',
  evidence: null,
  sourceUrl: null,
  isNew: false,
  submission: { status: 'draft', canContinue: true, submittedAt: null, graded: false, note: null },
};

const dueList: DueList = {
  generatedAt: AT,
  windowFrom: AT,
  windowTo: AT,
  items: [dueItem, { ...dueItem, cmid: null, kind: 'other', dueAt: null, submission: null, source: 'text' }],
  scope: { mode: 'mine', courseIds: [101], otherCount: 1 },
  otherCourses: [dueItem],
  sweep: { checked: 1, stale: 0, checkedAt: AT },
  truncated: false,
};

const moduleSummary: ModuleSummary = {
  cmid: 5001,
  name: 'Report 3',
  modname: 'assign',
  url: null,
  visible: true,
  dates: { due: AT },
  completed: null,
  files: [],
};

const outline: CourseOutline = {
  course,
  sections: [{ id: 1, number: 0, name: 'General', summary: '', modules: [moduleSummary] }],
};

const activities: ActivityDetail[] = [
  {
    type: 'assign',
    cmid: 5001,
    instanceId: 1,
    courseId: 101,
    courseName: 'Finance',
    name: 'Report 3',
    url: `${BASE}/mod/assign/view.php?id=5001`,
    description: 'Write a report.',
    attachments: [],
    opensAt: null,
    dueAt: AT,
    cutoffAt: null,
    submissionTypes: ['file'],
    maxFiles: 3,
    maxFileBytes: null,
    acceptedTypes: [],
    wordLimit: null,
    draftsEnabled: true,
    requiresStatement: false,
    statement: null,
    teamSubmission: false,
    submission: {
      status: 'new',
      gradingStatus: null,
      lastModified: null,
      onlineText: null,
      files: [],
      canEdit: true,
      canSubmit: true,
      locked: false,
      extensionDue: null,
    },
    feedback: null,
  },
  {
    type: 'quiz',
    cmid: 5002,
    instanceId: 2,
    courseId: 101,
    courseName: 'Finance',
    name: 'Quiz 1',
    url: `${BASE}/mod/quiz/view.php?id=5002`,
    description: '',
    opensAt: null,
    closesAt: null,
    timeLimitMinutes: null,
    attemptsAllowed: null,
    attempts: [],
    bestGrade: null,
  },
  {
    type: 'content',
    cmid: 5003,
    courseId: 101,
    courseName: 'Finance',
    name: 'Week 1 slides',
    modname: 'resource',
    url: `${BASE}/mod/resource/view.php?id=5003`,
    description: '',
    body: null,
    externalUrl: null,
    files: [],
  },
];

const discussion: DiscussionSummary = {
  forumType: 'forum',
  forumId: 7,
  forumCmid: 5004,
  forumName: 'Announcements',
  courseId: 101,
  courseName: 'Finance',
  discussionId: 31,
  firstPostId: 301,
  subject: 'Welcome',
  author: 'Teacher A',
  createdAt: AT,
  modifiedAt: null,
  replies: 0,
  unread: null,
  pinned: false,
};

const discussionPosts: Discussion = {
  summary: discussion,
  posts: [
    { id: 301, parentId: null, author: 'Teacher A', createdAt: AT, subject: 'Welcome', message: 'Hi', attachments: [] },
    { id: 302, parentId: 301, author: 'Student B', createdAt: null, subject: 'Re: Hi', message: 'Yo', attachments: [] },
  ],
  canReply: true,
};

const conversation: ConversationPage = {
  summary: {
    id: 9,
    name: 'Teacher A',
    type: 'private',
    unread: 1,
    lastMessage: 'See you',
    lastAt: AT,
    memberIds: [11, 12],
  },
  messages: [{ id: 1, author: 'Teacher A', fromMe: false, sentAt: AT, text: 'See you' }],
  members: [{ id: 11, name: 'Teacher A' }],
  nextOffset: null,
};

const notifications: NotificationPage = {
  notifications: [
    { id: 1, subject: 'Grade', text: 'Posted', sender: null, sentAt: AT, read: false, url: null, component: null },
  ],
  unreadCount: 1,
  nextOffset: 20,
};

const people: PeopleResult = {
  query: 'teacher',
  people: [{ id: 11, name: 'Teacher A', courses: ['Finance'], inConversation: true, announcements: true, seen: 3 }],
  skippedForums: 0,
};

const forumSearch: ForumSearchResult = {
  query: 'welcome',
  hits: [{ ...discussion, snippet: 'Hello and welcome', inSubject: true }],
  perForum: 20,
  skippedForums: 0,
  messages: [{ conversationId: 9, userId: 11, name: 'Teacher A', text: 'welcome back', sentAt: null, fromMe: false }],
  messagesNote: null,
};

const syllabusPage = parseSyllabusPage(JA_PAGE, 'ja');
const syllabus: SyllabusDetails = {
  courseId: 101,
  courseName: 'Finance',
  status: 'ok',
  requestedLang: 'ja',
  page: syllabusPage,
  url: 'https://www.wsl.waseda.jp/syllabus/JAA104.php?pKey=1&pLng=jp',
  searchUrl: 'https://www.wsl.waseda.jp/syllabus/index.php',
};

const quizReview: QuizReview = {
  cmid: 5002,
  quizId: 2,
  courseId: 101,
  courseName: 'Finance',
  name: 'Quiz 1',
  url: `${BASE}/mod/quiz/view.php?id=5002`,
  attempts: [{ attempt: 1, state: 'finished', startedAt: AT, finishedAt: AT, grade: '8.00 / 10.00' }],
  reviewedAttempt: 1,
  questions: [
    {
      number: '1',
      type: 'multichoice',
      state: 'gradedright',
      status: 'Correct',
      mark: 1,
      maxMark: 1,
      text: 'Pick one.',
      answer: '[x] A',
      rightAnswer: null,
      feedback: null,
    },
  ],
  note: null,
};

const timetable: Timetable = {
  from: '2026-10-19',
  to: '2026-10-19',
  days: [
    {
      date: '2026-10-19',
      weekday: 1,
      notes: [{ kind: 'held', name: 'Founders day' }],
      classes: [
        {
          courseId: 101,
          courseName: 'Finance',
          start: '08:50',
          end: '10:30',
          periods: 'P1',
          periodFrom: 1,
          periodTo: 1,
          night: false,
          classroom: null,
          campus: null,
          url: course.url,
          source: 'syllabus',
        },
      ],
    },
  ],
  onDemand: [{ courseId: 103, courseName: 'Online', url: 'u', term: null, kind: 'on-demand', alsoInClass: false }],
  unknown: [{ courseId: 104, courseName: 'Mystery', url: 'u', reason: 'pending' }],
  periodTimes: { standard: [{ period: 1, start: '08:50', end: '10:30' }], evening: [] },
  scopeMode: 'mine',
  approximate: false,
};

const override: ScheduleOverride = {
  mode: 'slots',
  slots: [{ weekday: 5, periodFrom: 1, periodTo: 2, night: false, classroom: '22-909' }],
  alsoOnDemand: false,
};

const update: CourseUpdate = {
  courseId: 101,
  courseName: 'Finance',
  cmid: 7001,
  name: 'Week 4 slides',
  modname: 'resource',
  change: 'new',
  what: [],
  at: AT,
  url: `${BASE}/mod/resource/view.php?id=7001`,
};

const fileLink: FileLink = {
  name: 'notes.txt',
  mime: 'text/plain',
  size: 5,
  downloadUrl: 'https://x.example/f/t',
  expiresAt: AT,
  inline: null,
};
const uploadLink: UploadLink = {
  uploadId: 'up_1',
  uploadUrl: 'https://x.example/u/t',
  draftItemId: 77,
  expiresAt: AT,
  maxBytes: 1_000_000,
  curlExample: 'curl -T file https://x.example/u/t',
};

const preview: ActionPreview = {
  actionId: 'act_1',
  kind: 'message',
  title: 'Send a message',
  details: ['To: Teacher A'],
  warnings: [],
  expiresAt: AT,
  approval: 'console',
  approveUrl: 'https://x.example/approve/act_1',
};
const previewChat: ActionPreview = { ...preview, approval: 'chat', approveUrl: null, details: [] };
const result: ActionResult = { actionId: 'act_1', status: 'executed', message: 'Done.', url: null };

const settings: UserSettings = { ...DEFAULT_SETTINGS, myCourseIds: [101] };
const gradesOverview: GradesResult = { overview: [{ courseId: 101, courseName: 'Finance', grade: 'A', raw: 90 }] };
const gradesCourse: GradesResult = {
  course: { courseId: 101, courseName: 'Finance', items: [] },
  note: 'Waseda Moodle hides the gradebook.',
};

/** tool name -> payloads its output schema must accept. */
export const OUTPUT_SAMPLES: Record<string, object[]> = {
  get_due_items: [dueList, { ...dueList, items: [], otherCourses: [], truncated: true }],
  list_courses: [
    { courses: [course], mode: 'mine', scope: 'mine' },
    { courses: [], mode: 'auto', scope: 'all' },
  ],
  get_course: [outline, { course, sections: [] }],
  search_course_content: [
    {
      hits: [{ courseId: 101, courseName: 'Finance', sectionName: 'General', module: moduleSummary }],
      searchedCourses: 1,
      refreshed: 0,
      skipped: 0,
    },
    { hits: [], searchedCourses: 0, refreshed: 0, skipped: 0 },
  ],
  get_activity: activities,
  get_grades: [gradesOverview, gradesCourse, { overview: [], note: 'Waseda Moodle hides the gradebook.' }],
  set_my_courses: [settings, { ...DEFAULT_SETTINGS }],
  get_course_updates: [
    { updates: [update], stats: { checked: 1, stale: 0, checkedAt: AT } },
    { updates: [], stats: { checked: 0, stale: 0, checkedAt: null } },
  ],
  get_timetable: [timetable, { ...timetable, days: [], onDemand: [], unknown: [] }],
  set_course_schedule: [
    { courseId: 101, schedule: override },
    { courseId: 101, schedule: null },
  ],
  get_syllabus: [syllabus, { ...syllabus, status: 'no-page', page: null, url: null }],
  get_quiz_review: [
    quizReview,
    { ...quizReview, attempts: [], reviewedAttempt: null, questions: [], note: 'No finished attempt.' },
  ],
  get_file: [
    { ...fileLink, inline: { mime: 'text/plain', attached: true } },
    { ...fileLink, mime: null, size: null },
  ],
  create_upload_link: [uploadLink],
  list_discussions: [
    { discussions: [discussion], skippedForums: 1 },
    { discussions: [], skippedForums: 0 },
  ],
  get_discussion: [discussionPosts, { ...discussionPosts, posts: [], canReply: false }],
  list_messages: [{ conversations: [conversation.summary] }, { conversations: [] }],
  get_conversation: [conversation, { ...conversation, messages: [], members: [] }],
  list_notifications: [notifications, { notifications: [], unreadCount: 0, nextOffset: null }],
  search_people: [people, { ...people, people: [] }],
  search_forums: [
    forumSearch,
    { ...forumSearch, hits: [], messages: null, messagesNote: 'Messages were not searched.' },
  ],
  prepare_submission: [preview, previewChat],
  prepare_forum_post: [preview, previewChat],
  prepare_forum_subscription: [preview, previewChat],
  prepare_message: [preview, previewChat],
  prepare_completion: [preview, previewChat],
  prepare_mark_read: [preview, previewChat],
  confirm_action: [result, { ...result, url: 'https://x.example/done' }],
  cancel_action: [{ ...result, status: 'cancelled' }],
};
