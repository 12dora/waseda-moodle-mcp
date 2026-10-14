/** Synthetic fixtures with the same shapes as Waseda Moodle responses (no real data). */

import type { RawAssign, RawAssignStatus } from '../../../src/core/services/activity/assign';
import type { RawModule, RawPage, RawUrl } from '../../../src/core/services/activity/content';
import type { RawBestGrade, RawQuiz, RawQuizAttempt } from '../../../src/core/services/activity/quiz';

const BASE = 'https://moodle.example.com';

/** As Waseda returns it: the settings list the online text plugin only, the file plugin shows up in the status. */
export const assignRaw: RawAssign = {
  id: 5001,
  cmid: 7001,
  course: 9001,
  name: 'Report 1 &amp; Case',
  intro: '<p>Write a short report.</p>',
  activity: '<p>Use <strong>two</strong> sources.</p>',
  duedate: 1792508340, // 2026-10-20 23:59 JST
  allowsubmissionsfromdate: 1791817200, // 2026-10-13 00:00 JST
  cutoffdate: 1792594740, // 2026-10-21 23:59 JST
  submissiondrafts: 1,
  teamsubmission: 0,
  requiresubmissionstatement: 1,
  submissionstatement:
    '<div><span lang="ja" class="multilang">日本語の注意<br />確認してください。</span>' +
    '<span lang="en" class="multilang">Please read this statement.</span></div>',
  configs: [
    { plugin: 'onlinetext', subtype: 'assignsubmission', name: 'enabled', value: '1' },
    { plugin: 'onlinetext', subtype: 'assignsubmission', name: 'wordlimit', value: '500' },
    { plugin: 'onlinetext', subtype: 'assignsubmission', name: 'wordlimitenabled', value: '1' },
    { plugin: 'comments', subtype: 'assignfeedback', name: 'enabled', value: '1' },
  ],
  introattachments: [
    {
      filename: 'brief.pdf',
      filepath: '/',
      filesize: 4096,
      fileurl: `${BASE}/webservice/pluginfile.php/111/mod_assign/introattachment/0/brief.pdf`,
      mimetype: 'application/pdf',
      timemodified: 1791276820,
    },
  ],
  activityattachments: [],
};

/** Same assignment when the settings do list the file plugin (limits known). */
export const assignRawFileConfigs: RawAssign = {
  ...assignRaw,
  configs: [
    ...(assignRaw.configs ?? []),
    { plugin: 'file', subtype: 'assignsubmission', name: 'enabled', value: '1' },
    { plugin: 'file', subtype: 'assignsubmission', name: 'maxfilesubmissions', value: '3' },
    { plugin: 'file', subtype: 'assignsubmission', name: 'maxsubmissionsizebytes', value: '1048576' },
    { plugin: 'file', subtype: 'assignsubmission', name: 'filetypeslist', value: '.pdf;docx document web_image' },
  ],
};

export const assignStatusDraft: RawAssignStatus = {
  lastattempt: {
    submission: {
      status: 'draft',
      timemodified: 1791939600, // 2026-10-14 10:00 JST
      plugins: [
        {
          type: 'onlinetext',
          fileareas: [{ area: 'submissions_onlinetext', files: [] }],
          editorfields: [{ name: 'onlinetext', text: '<p>My <em>draft</em> text</p>', format: 1 }],
        },
        {
          type: 'file',
          fileareas: [
            {
              area: 'submission_files',
              files: [
                {
                  filename: 'report.pdf',
                  filepath: '/',
                  filesize: 1234,
                  fileurl: `${BASE}/pluginfile.php/111/assignsubmission_file/submission_files/55/report.pdf?token=SECRET`,
                  mimetype: 'application/pdf',
                  timemodified: 1791939600,
                },
              ],
            },
          ],
        },
        { type: 'comments' },
      ],
    },
    canedit: true,
    cansubmit: true,
    locked: false,
    gradingstatus: 'notgraded',
    extensionduedate: 0,
  },
  feedback: {
    gradefordisplay: '85.00 / 100.00',
    gradeddate: 1791943200, // 2026-10-14 11:00 JST
    plugins: [
      { type: 'comments', editorfields: [{ name: 'comments', text: '<p>Good work.</p>', format: 1 }] },
      { type: 'file', fileareas: [{ area: 'feedback_files', files: [] }] },
      {
        type: 'editpdf',
        fileareas: [
          {
            area: 'download',
            files: [
              {
                filename: 'report-annotated.pdf',
                filepath: '/',
                filesize: 2048,
                fileurl: `${BASE}/webservice/pluginfile.php/111/assignfeedback_editpdf/download/55/report-annotated.pdf`,
                mimetype: 'application/pdf',
                timemodified: 1791943200,
              },
            ],
          },
        ],
      },
    ],
  },
  assignmentdata: {
    attachments: {
      // same file as introattachments -> deduplicated
      intro: [
        {
          filename: 'brief.pdf',
          filepath: '/',
          filesize: 4096,
          fileurl: `${BASE}/webservice/pluginfile.php/111/mod_assign/introattachment/0/brief.pdf`,
          mimetype: 'application/pdf',
          timemodified: 1791276820,
        },
      ],
    },
  },
};

/** No submission record yet (Moodle omits `submission`). */
/** A `new` submission record: nothing saved yet, but the record already has a timestamp. */
export const assignStatusNew: RawAssignStatus = {
  lastattempt: {
    submission: {
      status: 'new',
      timemodified: 1791937800,
      plugins: [
        { type: 'onlinetext', editorfields: [{ name: 'onlinetext', text: '', format: 0 }] },
        { type: 'file', fileareas: [{ area: 'submission_files', files: [] }] },
      ],
    },
    canedit: true,
    cansubmit: false,
  },
};

export const assignStatusNone: RawAssignStatus = {
  lastattempt: { canedit: true, cansubmit: false, locked: false, gradingstatus: 'notgraded', extensionduedate: null },
  feedback: null,
  assignmentdata: { attachments: { intro: [] } },
};

export const quizRaw: RawQuiz = {
  id: 6001,
  coursemodule: 7002,
  course: 9001,
  name: 'Midterm Quiz',
  intro: '<p>Closed book.</p>',
  timeopen: 1791817200,
  timeclose: 1792508340,
  timelimit: 3600,
  attempts: 2,
  grade: 10,
  sumgrades: 20,
  decimalpoints: 1,
  reviewmarks: 0x100, // marks visible "later, while the quiz is open"
};

export const quizAttempts: RawQuizAttempt[] = [
  { attempt: 2, state: 'inprogress', timestart: 1791939600, timefinish: 0, sumgrades: null, preview: 0 },
  { attempt: 1, state: 'finished', timestart: 1791860400, timefinish: 1791864000, sumgrades: 15, preview: 0 },
  { attempt: 0, state: 'finished', timestart: 1791860000, timefinish: 1791860100, sumgrades: 20, preview: 1 },
];

export const quizBest: RawBestGrade = { hasgrade: true, grade: 7.5 };

export const pageRaw: RawPage = {
  coursemodule: 7003,
  name: 'Syllabus &amp; Schedule',
  intro: '<p>Overview</p>',
  content: '<h2>Week 1</h2><p>Introduction</p><ul><li>Reading A</li></ul>',
  contentfiles: [
    {
      filename: 'schedule.png',
      filepath: '/',
      filesize: 77,
      fileurl: `${BASE}/webservice/pluginfile.php/333/mod_page/content/1/schedule.png`,
      mimetype: 'image/png',
      timemodified: 1791276820,
    },
  ],
};

export const urlRaw: RawUrl = {
  coursemodule: 7004,
  name: 'Reading list',
  intro: '<p>External site</p>',
  externalurl: 'https://library.example.com/list',
};

export const labelModule: RawModule = {
  id: 7005,
  name: 'Heads up',
  modname: 'label',
  description: '<p>Exam <strong>room</strong> changed.</p>',
  contents: [],
};

export const bookModule: RawModule = {
  id: 7006,
  name: 'Lecture notes',
  modname: 'book',
  description: '<p>Notes book</p>',
  contents: [
    {
      type: 'content',
      filename: 'structure',
      filepath: '/',
      fileurl: null,
      content: JSON.stringify([
        {
          title: 'Chapter 1',
          href: '1/index.html',
          level: 0,
          subitems: [{ title: 'Section 1.1', href: '2/index.html', level: 1, subitems: [] }],
        },
        { title: 'Q&amp;A', href: '3/index.html', level: 0, subitems: [] },
      ]),
    },
    {
      type: 'file',
      filename: 'index.html',
      filepath: '/1/',
      filesize: 10,
      fileurl: `${BASE}/webservice/pluginfile.php/444/mod_book/chapter/1/index.html`,
    },
  ],
};

export const folderModule: RawModule = {
  id: 7007,
  name: 'Materials',
  modname: 'folder',
  description: '',
  contents: [
    {
      type: 'file',
      filename: 'a.pdf',
      filepath: '/',
      filesize: 11,
      fileurl: `${BASE}/webservice/pluginfile.php/555/mod_folder/content/0/a.pdf?forcedownload=1`,
      mimetype: 'application/pdf',
      timemodified: 1791276820,
    },
    {
      type: 'file',
      filename: 'b.xlsx',
      filepath: '/data/',
      filesize: 22,
      fileurl: `${BASE}/webservice/pluginfile.php/555/mod_folder/content/0/data/b.xlsx?forcedownload=1`,
      mimetype: null,
      timemodified: 1791276820,
    },
  ],
};
