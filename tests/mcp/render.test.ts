import { describe, expect, it } from 'vitest';
import { renderActionPreview, renderActionResult } from '../../src/core/mcp/render/actions';
import { renderActivity } from '../../src/core/mcp/render/activity';
import { assembleTail, clip, MAX_TEXT_CHARS } from '../../src/core/mcp/render/common';
import { renderCourses, renderOutline, renderSearch } from '../../src/core/mcp/render/courses';
import { renderDueList } from '../../src/core/mcp/render/due';
import { renderFileLink, renderUploadLink } from '../../src/core/mcp/render/files';
import { renderDiscussion, renderDiscussions } from '../../src/core/mcp/render/forums';
import { renderGrades } from '../../src/core/mcp/render/grades';
import { renderConversation, renderConversations, renderNotifications } from '../../src/core/mcp/render/messages';
import { renderCourseUpdates, renderMyCourses } from '../../src/core/mcp/render/updates';
import type {
  ActionPreview,
  AssignDetail,
  Course,
  CourseUpdate,
  Discussion,
  DiscussionSummary,
  DueItem,
  DueList,
  FileLink,
  QuizDetail,
} from '../../src/core/types';

const LIMIT = MAX_TEXT_CHARS + 200;

function due(patch: Partial<DueItem>): DueItem {
  return {
    kind: 'assign',
    courseId: 101,
    courseName: 'Strategic Marketing',
    cmid: 5001,
    name: 'Report 3',
    opensAt: null,
    dueAt: '2026-10-15T23:59:00+09:00',
    midnightDue: false,
    overdue: false,
    closed: false,
    notOpenYet: false,
    url: 'https://moodle.example.edu/mod/assign/view.php?id=5001',
    action: null,
    source: 'calendar',
    evidence: null,
    sourceUrl: null,
    isNew: false,
    ...patch,
  };
}

function dueList(items: DueItem[], patch: Partial<DueList> = {}): DueList {
  return {
    generatedAt: '2026-10-14T12:00:00+09:00',
    windowFrom: '2026-09-30T12:00:00+09:00',
    windowTo: '2026-10-28T12:00:00+09:00',
    items,
    scope: { mode: 'mine', courseIds: [101], otherCount: 0 },
    sweep: { checked: 1, stale: 0, checkedAt: '2026-10-14T11:30:00+09:00' },
    truncated: false,
    ...patch,
  };
}

describe('assembleTail', () => {
  it('clips an oversized newest block so the footer survives and drops older blocks', () => {
    const t = assembleTail({
      head: ['head'],
      blocks: ['old block', 'x'.repeat(9000)],
      footer: ['FOOTER LINE'],
      noun: 'posts',
    });
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toContain('… 1 earlier posts omitted');
    expect(t.endsWith('FOOTER LINE')).toBe(true);
    expect(t).not.toContain('old block');
  });
});

describe('clip', () => {
  it('cuts with an ellipsis and keeps short text', () => {
    expect(clip('  hello  ', 10)).toBe('hello');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
    expect(clip(null, 5)).toBe('');
  });
});

describe('renderDueList', () => {
  const items = [
    due({ name: 'Old report', dueAt: '2026-10-10T23:59:00+09:00', overdue: true, cmid: 1 }),
    due({ name: 'Today quiz', kind: 'quiz', dueAt: '2026-10-14T18:00:00+09:00', cmid: 2 }),
    due({ name: 'Midnight task', dueAt: '2026-10-15T00:00:00+09:00', midnightDue: true, cmid: 3 }),
    due({ name: 'Tomorrow task', dueAt: '2026-10-15T23:59:00+09:00', cmid: 4 }),
    due({ name: 'Week task', dueAt: '2026-10-18T23:59:00+09:00', cmid: 5 }),
    due({ name: 'Later task', dueAt: '2026-10-30T23:59:00+09:00', cmid: null }),
    due({
      name: 'Opens later',
      kind: 'questionnaire',
      dueAt: null,
      opensAt: '2026-10-20T09:00:00+09:00',
      notOpenYet: true,
      cmid: 6,
    }),
  ];
  const text = renderDueList(dueList(items));

  it('groups by urgency in order', () => {
    const order = ['## Overdue (1)', '## Today (2)', '## Tomorrow (1)', '## Next 7 days (2)', '## Later (1)'].map((h) =>
      text.indexOf(h),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('formats lines and shows a midnight deadline as the previous day 24:00', () => {
    expect(text).toContain('- [assign] Old report — Strategic Marketing — due 2026-10-10 Sat 23:59 — OVERDUE (cmid 1)');
    expect(text).toContain('Midnight task — Strategic Marketing — due 2026-10-14 Wed 24:00 (cmid 3)');
    expect(text).toContain('opens 2026-10-20 Tue 09:00');
    expect(text).not.toContain('(cmid null)');
    expect(text).toContain('JST');
  });

  it('reports truncation, and says when nothing is due', () => {
    const t = renderDueList(dueList([due({})], { truncated: true }));
    expect(t).toContain('narrow with course_id');
    expect(renderDueList(dueList([]))).toContain('Nothing outstanding');
    expect(renderDueList(dueList([due({ overdue: true, closed: true })]))).toContain(
      '1 closed item no longer accepted',
    );
  });

  it('marks activity items without a deadline and tags new items', () => {
    const t = renderDueList(
      dueList([due({ source: 'activity', dueAt: null, name: 'Final task', isNew: true, cmid: 77 })]),
    );
    expect(t).toContain('## No deadline (1)');
    expect(t).toContain('Final task — Strategic Marketing — no deadline set in Moodle — NEW (cmid 77)');
  });

  it('lists at most 5 "No deadline" lines, newest first, and counts the rest', () => {
    const undated = Array.from({ length: 8 }, (_, i) =>
      due({ source: 'activity', dueAt: null, name: `Undated ${i}`, cmid: 100 + i, isNew: i === 1 }),
    );
    const t = renderDueList(dueList(undated));
    expect(t).toContain('## No deadline (8)');
    const shown = [...t.matchAll(/- \[assign\] (Undated \d)/g)].map((m) => m[1]);
    expect(shown).toEqual(['Undated 1', 'Undated 7', 'Undated 6', 'Undated 5', 'Undated 4']);
    expect(t).toContain("… 3 more without a deadline (see the console's Due page)");
    const few = renderDueList(dueList(undated.slice(0, 5)));
    expect(few).not.toContain('more without a deadline');
  });

  it('shows the evidence of a date a calendar item took from its own module text', () => {
    const t = renderDueList(
      dueList([due({ evidence: 'Deadline 18 October 2026', sourceUrl: 'https://moodle.example.edu/mod/x?id=1' })]),
    );
    expect(t).toContain('mentioned in course text — verify');
    expect(t).toContain('«Deadline 18 October 2026» https://moodle.example.edu/mod/x?id=1');
  });

  it('quotes the evidence and link of deadlines found in course text', () => {
    const t = renderDueList(
      dueList([
        due({
          source: 'text',
          name: 'Report Due on 10/18',
          evidence: 'Report Due on 10/18 (Sun) 23:59 via the form',
          sourceUrl: 'https://moodle.example.edu/course/view.php?id=101#section-2',
        }),
      ]),
    );
    expect(t).toContain('mentioned in course text — verify');
    expect(t).toContain(
      '«Report Due on 10/18 (Sun) 23:59 via the form» https://moodle.example.edu/course/view.php?id=101#section-2',
    );
  });

  it('shows the scope and sweep coverage in the footer', () => {
    const mine = renderDueList(dueList([due({})], { scope: { mode: 'mine', courseIds: [1, 2, 3], otherCount: 4 } }));
    expect(mine).toContain('Your courses: 3.');
    expect(mine).toContain('4 other enrolled courses not included');
    expect(mine).toContain('Course pages checked: 1, last check 2026-10-14');
    const auto = renderDueList(
      dueList([due({})], {
        scope: { mode: 'auto', courseIds: [1, 2], otherCount: 0 },
        sweep: { checked: 1, stale: 2, checkedAt: null },
      }),
    );
    expect(auto).toContain('Using suggested courses (2)');
    expect(auto).toContain('set_my_courses');
    expect(auto).toContain('2 courses not refreshed yet');
  });

  it('truncates long lists with a "more" line', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      due({ name: `Assignment number ${i}`, dueAt: '2026-10-20T23:59:00+09:00', cmid: 9000 + i }),
    );
    const t = renderDueList(dueList(many));
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toMatch(/… \d+ more \(use course_id or a smaller days_ahead\)/);
  });
});

describe('renderDueList budget order', () => {
  it('keeps today and tomorrow when a long overdue list overflows, and puts closed items last', () => {
    const overdue = Array.from({ length: 80 }, (_, i) =>
      due({ name: `Old assignment number ${i}`, dueAt: '2026-10-01T23:59:00+09:00', overdue: true, cmid: 100 + i }),
    );
    const closed = due({
      name: 'Expired quiz',
      kind: 'quiz',
      dueAt: '2026-09-20T23:59:00+09:00',
      overdue: true,
      closed: true,
    });
    const items = [
      ...overdue,
      closed,
      due({ name: 'Due today', dueAt: '2026-10-14T20:00:00+09:00', cmid: 1 }),
      due({ name: 'Due tomorrow', dueAt: '2026-10-15T20:00:00+09:00', cmid: 2 }),
      due({ name: 'Due next week', dueAt: '2026-10-20T20:00:00+09:00', cmid: 3 }),
    ];
    const t = renderDueList(dueList(items));
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toContain('Due today');
    expect(t).toContain('Due tomorrow');
    expect(t).toContain('Due next week');
    expect(t).toMatch(/## Overdue \(80\)[\s\S]*… \d+ more/);
    expect(t.indexOf('## Overdue')).toBeLessThan(t.indexOf('## Today'));
    const last = t.trimEnd().split('\n').at(-1) ?? '';
    expect(last).toMatch(/^1 closed item no longer accepted: Expired quiz/);
    expect(t).not.toContain('- [quiz] Expired quiz');
  });

  it('puts open items without a deadline into a final "No deadline" group', () => {
    const items = [
      due({ name: 'Open survey', kind: 'questionnaire', dueAt: null, opensAt: '2026-10-10T09:00:00+09:00', cmid: 7 }),
      due({
        name: 'Survey opening tomorrow',
        kind: 'questionnaire',
        dueAt: null,
        opensAt: '2026-10-15T09:00:00+09:00',
        notOpenYet: true,
        cmid: 8,
      }),
      due({ name: 'Due today', dueAt: '2026-10-14T20:00:00+09:00', cmid: 1 }),
      due({ name: 'Far away', dueAt: '2026-11-30T20:00:00+09:00', cmid: 2 }),
    ];
    const t = renderDueList(dueList(items));
    expect(t).toContain('## No deadline (1)');
    expect(t).toContain('Open survey — Strategic Marketing — open since 2026-10-10 Sat 09:00, no deadline (cmid 7)');
    expect(t.indexOf('## No deadline')).toBeGreaterThan(t.indexOf('## Later'));
    expect(t.indexOf('Open survey')).toBeGreaterThan(t.indexOf('## No deadline'));
    // not yet open: keeps its opening time in the matching day group
    expect(t.indexOf('Survey opening tomorrow')).toBeGreaterThan(t.indexOf('## Tomorrow'));
    expect(t.indexOf('Survey opening tomorrow')).toBeLessThan(t.indexOf('## Later'));
    expect(t.indexOf('## Today')).toBeLessThan(t.indexOf('Due today'));
  });

  it('groups a deadline at 00:00 with the day it is shown on and uses generatedAt as now', () => {
    const list = dueList(
      [
        due({ name: 'Midnight', dueAt: '2026-10-22T00:00:00+09:00', midnightDue: true }),
        due({ name: 'Day after', dueAt: '2026-10-22T00:01:00+09:00' }),
      ],
      { generatedAt: '2026-10-14T12:00:00+09:00' },
    );
    const t = renderDueList(list);
    expect(t.indexOf('Midnight')).toBeLessThan(t.indexOf('## Later'));
    expect(t.indexOf('Day after')).toBeGreaterThan(t.indexOf('## Later'));
    expect(t).toContain('## Next 7 days (1)');
    expect(t).toContain('due 2026-10-21 Wed 24:00');
  });
});

function course(patch: Partial<Course> = {}): Course {
  return {
    id: 101,
    name: 'Finance',
    shortName: 'F',
    category: null,
    url: 'u',
    start: null,
    end: null,
    progress: 40.4,
    kind: 'class',
    mine: true,
    suggested: true,
    term: null,
    lastAccess: null,
    ...patch,
  };
}

describe('courses, outline, search', () => {
  it('renders your courses with term and last access, and tells the model to confirm suggestions', () => {
    const t = renderCourses([course({ term: '秋クォーター', lastAccess: '2026-10-12T09:30:00+09:00' })], {
      mode: 'auto',
      scope: 'mine',
    });
    expect(t).toContain('## Your courses (1)');
    expect(t).toContain('course_id 101');
    expect(t).toContain('秋クォーター');
    expect(t).toContain('last access 2026-10-12');
    expect(t).toContain('progress 40%');
    expect(t).toContain('call set_my_courses');
    expect(t).toContain('scope "all"');
    expect(renderCourses([], { mode: 'mine', scope: 'mine' })).toContain('No courses');
  });

  it('lists other class courses and collapses non-class courses to names', () => {
    const list = [
      course(),
      course({ id: 102, name: 'Old seminar', mine: false, suggested: true }),
      course({ id: 900, name: 'Library guide', kind: 'other', mine: false, suggested: false }),
    ];
    const t = renderCourses(list, { mode: 'mine', scope: 'all' });
    expect(t).toContain('## Other class courses (1)');
    expect(t).toContain('Old seminar — course_id 102 — progress 40% — suggested');
    expect(t).toContain('## Other enrolled (1)');
    expect(t).toContain('Library guide (900)');
    expect(t).not.toContain('course_id 900');
    expect(t).not.toContain('scope "all"');
    expect(t).not.toContain('set_my_courses');
  });

  it('renders an outline with dates, completion and file names, skipping empty sections', () => {
    const mod = (cmid: number, patch = {}) => ({
      cmid,
      name: `Item ${cmid}`,
      modname: 'resource',
      url: null,
      visible: true,
      dates: {},
      completed: null,
      files: [],
      ...patch,
    });
    const t = renderOutline({
      course: {
        id: 101,
        name: 'Finance',
        shortName: 'F',
        category: null,
        url: 'https://moodle.example.edu/course/view.php?id=101',
        start: null,
        end: null,
        progress: null,
        kind: 'class',
        mine: true,
        suggested: true,
        term: null,
        lastAccess: null,
      },
      sections: [
        { id: 1, number: 0, name: 'General', summary: '', modules: [] },
        {
          id: 2,
          number: 1,
          name: 'Week 1',
          summary: 'Intro',
          modules: [
            mod(11, { modname: 'assign', dates: { due: '2026-10-15T23:59:00+09:00' }, completed: false }),
            mod(12, { files: [{ name: 'slides.pdf', size: 10, mime: null, url: 'x', modified: null }] }),
          ],
        },
      ],
    });
    expect(t).not.toContain('General');
    expect(t).toContain('## 1. Week 1');
    expect(t).toContain('- [assign] Item 11 (cmid 11) — due 2026-10-15 Thu 23:59 — not done');
    expect(t).toContain('files: slides.pdf');
  });

  it('renders search hits and the empty case', () => {
    const hit = {
      courseId: 101,
      courseName: 'Finance',
      sectionName: 'Week 2',
      module: {
        cmid: 21,
        name: 'Slides W2',
        modname: 'resource',
        url: null,
        visible: true,
        dates: {},
        completed: null,
        files: [],
      },
    };
    const t = renderSearch({ hits: [hit], searchedCourses: 3 }, 'slides');
    expect(t).toContain('1 match for "slides" in 3 courses');
    expect(t).toContain('(cmid 21)');
    expect(renderSearch({ hits: [], searchedCourses: 2 }, 'x')).toContain('No matches');
  });
});

describe('renderActivity', () => {
  const base: AssignDetail = {
    type: 'assign',
    cmid: 5001,
    instanceId: 15,
    courseId: 101,
    courseName: 'Strategic Marketing',
    name: 'Report 3',
    url: 'https://moodle.example.edu/mod/assign/view.php?id=5001',
    description: 'Write 2000 words.',
    attachments: [
      {
        name: 'brief.pdf',
        size: 2048,
        mime: 'application/pdf',
        url: 'https://moodle.example.edu/webservice/pluginfile.php/1/brief.pdf',
        modified: null,
      },
    ],
    opensAt: '2026-10-01T09:00:00+09:00',
    dueAt: '2026-10-15T00:00:00+09:00',
    cutoffAt: null,
    submissionTypes: ['onlinetext', 'file'],
    maxFiles: 3,
    maxFileBytes: 10 * 1024 * 1024,
    acceptedTypes: ['.pdf', '.docx'],
    wordLimit: 500,
    draftsEnabled: true,
    requiresStatement: true,
    statement: 'This is my own work.',
    teamSubmission: false,
    submission: {
      status: 'draft',
      gradingStatus: null,
      lastModified: '2026-10-12T10:00:00+09:00',
      onlineText: 'My draft',
      files: [],
      canEdit: true,
      canSubmit: true,
      locked: false,
      extensionDue: null,
    },
    feedback: { grade: '85 / 100', gradedAt: null, comments: 'Well done.', files: [] },
  };

  it('renders an assignment with limits, status, statement, feedback and attachment URL', () => {
    const t = renderActivity(base);
    expect(t).toContain('# Report 3 — assignment (cmid 5001)');
    expect(t).toContain('Due: 2026-10-14 Wed 24:00');
    expect(t).toContain('online text (max 500 words) + file upload (up to 3 files, 10 MB each; types .pdf .docx)');
    expect(t).toContain('Your submission: draft');
    expect(t).toContain('drafts must be submitted');
    expect(t).toContain('This is my own work.');
    expect(t).toContain('Feedback: grade 85 / 100');
    expect(t).toContain('brief.pdf (2.0 KB) — https://moodle.example.edu/webservice/pluginfile.php/1/brief.pdf');
    expect(t).toContain('Write 2000 words.');
  });

  it('caps a huge description', () => {
    const t = renderActivity({ ...base, description: 'word '.repeat(5000) });
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toContain('…');
  });

  it('renders quizzes, forums and content', () => {
    const quiz: QuizDetail = {
      type: 'quiz',
      cmid: 7,
      instanceId: 1,
      courseId: 1,
      courseName: 'C',
      name: 'Quiz 1',
      url: 'u',
      description: '',
      opensAt: null,
      closesAt: '2026-10-20T10:00:00+09:00',
      timeLimitMinutes: 30,
      attemptsAllowed: 2,
      attempts: [
        { attempt: 1, state: 'finished', startedAt: null, finishedAt: '2026-10-10T10:00:00+09:00', grade: '8.0' },
      ],
      bestGrade: '8.0',
    };
    const q = renderActivity(quiz);
    expect(q).toContain('Time limit: 30 min · Attempts allowed: 2');
    expect(q).toContain('#1 finished');
    expect(q).toContain('cannot attempt them');

    const disc: DiscussionSummary = discussion(5);
    const f = renderActivity({
      type: 'forum',
      cmid: 8,
      forumId: 3,
      forumType: 'hsuforum',
      courseId: 1,
      courseName: 'C',
      name: 'Q&A',
      url: 'u',
      description: '',
      dueAt: null,
      discussions: [disc],
    });
    expect(f).toContain('forum_type forum, discussion_id 5');

    const c = renderActivity({
      type: 'content',
      cmid: 9,
      courseId: 1,
      courseName: 'C',
      name: 'Slides',
      modname: 'resource',
      url: 'u',
      description: 'Week 1',
      body: null,
      externalUrl: 'https://example.com/a',
      files: [
        {
          name: 's.pdf',
          size: 1,
          mime: null,
          url: 'https://moodle.example.edu/webservice/pluginfile.php/2/s.pdf',
          modified: null,
        },
      ],
    });
    expect(c).toContain('External link: https://example.com/a');
    expect(c).toContain('pass a url to get_file');
  });
});

function discussion(id: number, patch: Partial<DiscussionSummary> = {}): DiscussionSummary {
  return {
    forumType: 'forum',
    forumId: 3,
    forumCmid: 88,
    forumName: 'News',
    courseId: 101,
    courseName: 'Finance',
    discussionId: id,
    firstPostId: id * 10,
    subject: `Subject ${id}`,
    author: 'Prof. Sato',
    createdAt: '2026-10-10T10:00:00+09:00',
    modifiedAt: '2026-10-12T10:00:00+09:00',
    replies: 2,
    unread: 1,
    pinned: false,
    ...patch,
  };
}

describe('files', () => {
  const link: FileLink = {
    name: 'Lecture 1 (slides).pdf',
    mime: 'application/pdf',
    size: 1536,
    downloadUrl: 'https://wasemoodle.example.com/f/tkt',
    expiresAt: '2026-10-14T12:15:00+09:00',
    inline: null,
  };

  it('renders the link with a shell-safe curl example', () => {
    const t = renderFileLink(link);
    expect(t).toContain('application/pdf, 1.5 KB');
    expect(t).toContain('valid until 2026-10-14 Wed 12:15 JST');
    expect(t).toContain("curl -fL -o 'Lecture_1_slides_.pdf' 'https://wasemoodle.example.com/f/tkt'");
  });

  it('handles local file URLs and inline notes', () => {
    const t = renderFileLink({ ...link, downloadUrl: 'file:///tmp/a.pdf', inline: { mime: 'text/plain', text: 'x' } });
    expect(t).toContain('Saved locally: file:///tmp/a.pdf');
    expect(t).not.toContain('curl');
    expect(t).toContain('also attached');
  });

  it('renders an upload link', () => {
    const t = renderUploadLink(
      {
        uploadUrl: 'https://s.example.com/u/t',
        draftItemId: 1,
        expiresAt: '2026-10-14T12:30:00+09:00',
        maxBytes: 20 * 1024 * 1024,
        curlExample: 'curl -T ./report.pdf "https://s.example.com/u/t?name=report.pdf"',
        uploadId: 'upl_1',
      },
      5001,
    );
    expect(t).toContain('max 20 MB');
    expect(t).toContain('upload_id "upl_1"');
    expect(t).toContain('cmid 5001');
  });
});

describe('grades', () => {
  it('renders an overview, a course and notes', () => {
    expect(renderGrades({ overview: [{ courseId: 1, courseName: 'Finance', grade: 'A', raw: 90 }] })).toContain(
      'Finance (course_id 1): A',
    );
    const empty = renderGrades({ overview: [], note: 'Pass course_id for per-course grades.' });
    expect(empty).toContain('Note: Pass course_id');
    expect(renderGrades({ overview: [] })).toContain('Pass course_id');
    const t = renderGrades({
      course: {
        courseId: 1,
        courseName: 'Finance',
        items: [
          {
            name: 'Report 1',
            itemType: 'mod',
            modname: 'assign',
            cmid: 5,
            grade: '85',
            range: '0–100',
            percentage: '85 %',
            feedback: 'Good',
            weight: null,
            gradedAt: null,
          },
          {
            name: 'Course total',
            itemType: 'course',
            modname: null,
            cmid: null,
            grade: '85',
            range: null,
            percentage: null,
            feedback: null,
            weight: null,
            gradedAt: null,
          },
        ],
      },
      note: 'Collected from feedback.',
    });
    expect(t).toContain('- Report 1 (cmid 5): 85 / 0–100 (85 %) — "Good"');
    expect(t).toContain('**Course total**: 85');
    expect(t).toContain('Note: Collected from feedback.');
  });
});

describe('forums', () => {
  it('lists discussions with ids needed for get_discussion', () => {
    const t = renderDiscussions({ discussions: [discussion(5, { pinned: true })], skippedForums: 3 });
    expect(t).toContain('[pinned] Subject 5');
    expect(t).toContain('forum_type forum, discussion_id 5, forum_cmid 88');
    expect(t).toContain('1 unread');
    expect(t).toContain('3 forums not checked');
    expect(renderDiscussions({ discussions: [], skippedForums: 0 })).toBe('No discussions found.');
  });

  it('renders a discussion and keeps the newest posts when it is too long', () => {
    const posts = Array.from({ length: 40 }, (_, i) => ({
      id: 100 + i,
      parentId: i ? 100 : null,
      author: `Student ${i}`,
      createdAt: '2026-10-12T10:00:00+09:00',
      subject: 'Re: x',
      message: `Post body ${i} ${'blah '.repeat(80)}`,
      attachments: [],
    }));
    const d: Discussion = { summary: discussion(5), posts, canReply: true };
    const t = renderDiscussion(d);
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toMatch(/… \d+ earlier posts omitted/);
    expect(t).toContain('post_id 139');
    expect(t).not.toContain('post_id 100)');
    expect(t).toContain('prepare_forum_post with reply_to_post_id');
    expect(renderDiscussion({ ...d, posts: posts.slice(0, 1), canReply: false })).toContain('Replying is not allowed');
  });
});

describe('messages and notifications', () => {
  it('renders conversations and a conversation', () => {
    const summary = {
      id: 12,
      name: 'Prof. Sato',
      type: 'private' as const,
      unread: 2,
      lastMessage: 'See you\nthen',
      lastAt: '2026-10-13T09:00:00+09:00',
      memberIds: [1, 2],
    };
    const t = renderConversations([summary]);
    expect(t).toContain('conversation_id 12 — 2 unread — last: "See you then"');
    expect(renderConversations([])).toContain('No conversations');
    const c = renderConversation({
      summary,
      messages: [
        { id: 1, author: 'Prof. Sato', fromMe: false, sentAt: '2026-10-13T09:00:00+09:00', text: 'Hello' },
        { id: 2, author: 'Taro Yamada', fromMe: true, sentAt: '2026-10-13T09:05:00+09:00', text: 'Hi' },
      ],
    });
    expect(c).toContain('[2026-10-13 Tue 09:00] Prof. Sato: Hello');
    expect(c).toContain('You: Hi');
  });

  it('renders notifications', () => {
    const t = renderNotifications({
      unreadCount: 1,
      notifications: [
        {
          id: 1,
          subject: 'Grade posted',
          text: 'Report 1 graded',
          sender: 'Moodle',
          sentAt: '2026-10-13T09:00:00+09:00',
          read: false,
          url: null,
          component: null,
        },
        {
          id: 2,
          subject: 'Old',
          text: '',
          sender: null,
          sentAt: '2026-10-01T09:00:00+09:00',
          read: true,
          url: null,
          component: null,
        },
      ],
    });
    expect(t).toContain('1 unread notification.');
    expect(t).toContain('[unread] 2026-10-13 Tue 09:00 — Grade posted — Report 1 graded (Moodle)');
    expect(t).toContain('- 2026-10-01 Thu 09:00 — Old');
    expect(renderNotifications({ unreadCount: 0, notifications: [] })).toContain('Nothing to show');
  });
});

describe('actions', () => {
  const preview: ActionPreview = {
    actionId: 'act_abc',
    kind: 'assign_submit',
    title: "Submit to 'Report 3' (Strategic Marketing)",
    details: ['File: report.pdf (120 KB)', 'Will be submitted for grading'],
    warnings: ['Replaces your existing submission'],
    expiresAt: '2026-10-14T12:30:00+09:00',
    approval: 'chat',
    approveUrl: null,
  };

  it('tells the model to show the preview and confirm only after agreement', () => {
    const t = renderActionPreview(preview);
    expect(t).toContain("Action preview: Submit to 'Report 3'");
    expect(t).toContain('Details:\n- File: report.pdf (120 KB)');
    expect(t).toContain('Warnings:\n- Replaces your existing submission');
    expect(t).toContain(
      'Show this preview to the user. Call confirm_action with action_id "act_abc" only after they agree',
    );
  });

  it('points to the console for console approval', () => {
    const t = renderActionPreview({
      ...preview,
      approval: 'console',
      approveUrl: 'https://wasemoodle.example.com/actions?focus=act_abc',
    });
    expect(t).toContain('approve it in the console: https://wasemoodle.example.com/actions?focus=act_abc');
    expect(t).not.toContain('Call confirm_action with');
  });

  it('shows the executing status as running', () => {
    expect(renderActionResult({ actionId: 'act_abc', status: 'executing', message: 'In progress.', url: null })).toBe(
      'Action act_abc: running. In progress.',
    );
  });

  it('renders results', () => {
    expect(
      renderActionResult({
        actionId: 'act_abc',
        status: 'executed',
        message: 'Submitted.',
        url: 'https://moodle.example.edu/x',
      }),
    ).toBe('Action act_abc: executed. Submitted.\nhttps://moodle.example.edu/x');
  });
});

describe('course updates', () => {
  const upd = (patch: Partial<CourseUpdate>): CourseUpdate => ({
    courseId: 101,
    courseName: 'Strategic Marketing',
    cmid: 1,
    name: 'Week 1 slides',
    modname: 'resource',
    change: 'new',
    what: [],
    at: '2026-10-12T10:00:00+09:00',
    url: 'https://moodle.example.edu/mod/resource/view.php?id=1',
    ...patch,
  });
  const stats = { checked: 2, stale: 0, checkedAt: '2026-10-14T11:00:00+09:00' };

  it('groups by course with the newest course and item first, labelling new and updated items', () => {
    const t = renderCourseUpdates(
      {
        updates: [
          upd({ cmid: 1, at: '2026-10-10T10:00:00+09:00' }),
          upd({
            cmid: 2,
            courseId: 102,
            courseName: 'Marketing',
            name: 'Case',
            modname: 'assign',
            at: '2026-10-13T08:00:00+09:00',
          }),
          upd({
            cmid: 3,
            change: 'updated',
            what: ['contentfiles'],
            name: 'Week 2 slides',
            at: '2026-10-12T10:00:00+09:00',
          }),
        ],
        stats,
      },
      7,
    );
    expect(t.indexOf('## Marketing (course_id 102)')).toBeLessThan(t.indexOf('## Strategic Marketing (course_id 101)'));
    expect(t.indexOf('Week 2 slides')).toBeLessThan(t.indexOf('Week 1 slides'));
    expect(t).toContain('- NEW [assign] Case (cmid 2) — 2026-10-13 Tue 08:00 — https://moodle.example.edu');
    expect(t).toContain('- updated (contentfiles) [resource] Week 2 slides (cmid 3)');
    expect(t).toContain('get_activity');
    expect(t).toContain('Checked 2 courses');
  });

  it('says so when nothing changed, mentions stale courses and truncates long lists', () => {
    const none = renderCourseUpdates({ updates: [], stats: { ...stats, stale: 1 } }, 3);
    expect(none).toContain('No new or changed course content in the last 3 days');
    expect(none).toContain('1 course not refreshed yet');
    const many = Array.from({ length: 80 }, (_, i) => upd({ cmid: i, name: `Slides number ${i}` }));
    const t = renderCourseUpdates({ updates: many, stats }, 7);
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toMatch(/… \d+ more \(pass course_id or a smaller since_days\)/);
  });

  it('confirms the saved selection', () => {
    expect(renderMyCourses([5, 6])).toContain('2 courses (course_id 5, 6)');
    expect(renderMyCourses(null)).toContain('automatic');
  });
});
