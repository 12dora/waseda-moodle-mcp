import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MoodleError, NotFound } from '../../src/core/errors';
import { getActivity } from '../../src/core/services/activity';
import { mapAssign, parseFileTypes } from '../../src/core/services/activity/assign';
import { mapBookStructure, mapContentFiles } from '../../src/core/services/activity/content';
import { mapQuiz } from '../../src/core/services/activity/quiz';
import type { AssignDetail, ContentDetail, ForumDetail, QuizDetail } from '../../src/core/types';
import {
  assignRaw,
  assignRawFileConfigs,
  assignStatusDraft,
  assignStatusNew,
  assignStatusNone,
  bookModule,
  folderModule,
  labelModule,
  pageRaw,
  quizAttempts,
  quizBest,
  quizRaw,
  urlRaw,
} from '../fixtures/be3/activity';
import { forumDiscussions, forumsC1, hsuDiscussions, hsuForumsC1 } from '../fixtures/be3/forums';
import { countCalls, FAKE_BASE_URL, makeFakeContext } from '../helpers/fake-context-be3';

vi.mock('../../src/core/services/courses', () => ({
  listAllCourses: vi.fn(async () => [
    { id: 9001, name: 'Corporate Finance Basics' },
    { id: 9002, name: 'Seminar & Lab' },
  ]),
}));

// 2026-10-14 10:30 JST: inside the fixtures' open window
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T10:30:00+09:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

const info = {
  courseId: 9001,
  courseName: 'Corporate Finance Basics',
  url: `${FAKE_BASE_URL}/mod/assign/view.php?id=7001`,
};
const cmOf = (id: number, modname: string, instance: number, course = 9001) => ({
  cm: { id, course, modname, instance, name: 'ignored' },
  warnings: [],
});

describe('parseFileTypes', () => {
  it('normalises extensions, keeps groups and mime types', () => {
    expect(parseFileTypes('.pdf;docx document, image/png .PDF')).toEqual(['.pdf', '.docx', 'document', 'image/png']);
  });
  it('treats undotted tokens with an underscore as mime groups', () => {
    expect(parseFileTypes('web_audio html_track media_source mp3')).toEqual([
      'web_audio',
      'html_track',
      'media_source',
      '.mp3',
    ]);
  });
  it('treats empty and wildcard as any type', () => {
    expect(parseFileTypes('')).toEqual([]);
    expect(parseFileTypes(null)).toEqual([]);
    expect(parseFileTypes('.pdf,*')).toEqual([]);
  });
});

describe('mapAssign', () => {
  const a = mapAssign(assignRaw, assignStatusDraft, { ...info, lang: 'en' });

  it('maps settings', () => {
    expect(a).toMatchObject({
      type: 'assign',
      cmid: 7001,
      instanceId: 5001,
      courseId: 9001,
      courseName: 'Corporate Finance Basics',
      name: 'Report 1 & Case',
      opensAt: '2026-10-13T00:00:00+09:00',
      dueAt: '2026-10-20T23:59:00+09:00',
      cutoffAt: '2026-10-21T23:59:00+09:00',
      submissionTypes: ['onlinetext', 'file'], // the file plugin is only visible in the status
      maxFiles: null,
      maxFileBytes: null,
      acceptedTypes: [],
      wordLimit: 500,
      draftsEnabled: true,
      requiresStatement: true,
      teamSubmission: false,
    });
  });

  it('reads the file limits from the settings when they list the plugin', () => {
    const f = mapAssign(assignRawFileConfigs, assignStatusDraft, { ...info, lang: 'en' });
    expect(f).toMatchObject({
      submissionTypes: ['onlinetext', 'file'],
      maxFiles: 3,
      maxFileBytes: 1048576,
      acceptedTypes: ['.pdf', '.docx', 'document', 'web_image'],
    });
    // settings alone are enough when there is no status
    expect(mapAssign(assignRawFileConfigs, null, info).submissionTypes).toEqual(['onlinetext', 'file']);
    expect(mapAssign(assignRaw, null, info).submissionTypes).toEqual(['onlinetext']);
  });

  it('joins intro and activity as markdown', () => {
    expect(a.description).toContain('Write a short report.');
    expect(a.description).toContain('two');
    expect(a.description).not.toContain('<p>');
  });

  it('picks the statement language and drops the others', () => {
    expect(a.statement).toContain('Please read this statement.');
    expect(a.statement).not.toContain('日本語');
    const ja = mapAssign(assignRaw, assignStatusDraft, { ...info, lang: 'ja' });
    expect(ja.statement).toContain('日本語');
    expect(ja.statement).not.toContain('Please read');
  });

  it('dedupes attachments by url', () => {
    expect(a.attachments).toHaveLength(1);
    expect(a.attachments[0]).toMatchObject({ name: 'brief.pdf', size: 4096, mime: 'application/pdf' });
  });

  it('maps the draft submission and strips tokens from file urls', () => {
    expect(a.submission).toMatchObject({
      status: 'draft',
      gradingStatus: 'notgraded',
      lastModified: '2026-10-14T10:00:00+09:00',
      canEdit: true,
      canSubmit: true,
      locked: false,
      extensionDue: null,
    });
    expect(a.submission.onlineText).toContain('draft');
    expect(a.submission.files).toHaveLength(1);
    expect(a.submission.files[0]?.url).toBe(
      `${FAKE_BASE_URL}/webservice/pluginfile.php/111/assignsubmission_file/submission_files/55/report.pdf`,
    );
  });

  it('maps feedback', () => {
    expect(a.feedback).toMatchObject({ grade: '85.00 / 100.00', gradedAt: '2026-10-14T11:00:00+09:00' });
    expect(a.feedback?.comments).toContain('Good work.');
    // files of every feedback plugin, including the annotated PDF of editpdf
    expect(a.feedback?.files.map((f) => f.name)).toEqual(['report-annotated.pdf']);
  });

  it('keeps feedback when only a file exists and drops it when nothing exists', () => {
    const onlyFile = { feedback: { gradefordisplay: '-', plugins: assignStatusDraft.feedback?.plugins?.slice(2) } };
    expect(mapAssign(assignRaw, onlyFile, info).feedback).toMatchObject({ grade: null, comments: null });
    expect(mapAssign(assignRaw, { feedback: { gradefordisplay: '-', plugins: [] } }, info).feedback).toBeNull();
  });

  it('has no modification time for a record that is still "new"', () => {
    const n = mapAssign(assignRaw, assignStatusNew, info);
    expect(n.submission).toMatchObject({ status: 'new', lastModified: null, onlineText: null, files: [] });
    expect(n.submissionTypes).toEqual(['onlinetext', 'file']);
  });

  it('handles a missing submission and feedback', () => {
    const n = mapAssign(assignRaw, assignStatusNone, info);
    expect(n.submission).toMatchObject({
      status: 'none',
      onlineText: null,
      files: [],
      canEdit: true,
      canSubmit: false,
    });
    expect(n.feedback).toBeNull();
    const noStatus = mapAssign(assignRaw, null, info);
    expect(noStatus.submission.status).toBe('none');
    expect(noStatus.submission.canEdit).toBe(false);
  });

  it('ignores a word limit that is switched off', () => {
    const raw = {
      ...assignRaw,
      configs: (assignRaw.configs ?? []).map((c) => (c.name === 'wordlimitenabled' ? { ...c, value: '0' } : c)),
    };
    expect(mapAssign(raw, null, info).wordLimit).toBeNull();
  });

  it('uses the team submission for team assignments', () => {
    const status = {
      lastattempt: {
        submission: { status: 'new' },
        teamsubmission: { status: 'submitted', timemodified: 1791939600 },
        canedit: false,
      },
    };
    expect(mapAssign({ ...assignRaw, teamsubmission: 1 }, status, info).submission.status).toBe('submitted');
    expect(mapAssign(assignRaw, status, info).submission.status).toBe('new');
  });
});

describe('mapQuiz', () => {
  const base = { courseId: 9001, courseName: 'Corporate Finance Basics', url: 'u', now: 1791943200 }; // 11:00 JST, quiz open

  it('maps settings, attempts (no previews, oldest first) and grades', () => {
    const q = mapQuiz(quizRaw, quizAttempts, quizBest, base);
    expect(q).toMatchObject({
      type: 'quiz',
      cmid: 7002,
      instanceId: 6001,
      name: 'Midterm Quiz',
      opensAt: '2026-10-13T00:00:00+09:00',
      closesAt: '2026-10-20T23:59:00+09:00',
      timeLimitMinutes: 60,
      attemptsAllowed: 2,
      bestGrade: '7.5 / 10',
    });
    expect(q.description).toContain('Closed book.');
    expect(q.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(q.attempts[0]).toMatchObject({
      state: 'finished',
      grade: '7.5 / 10',
      finishedAt: '2026-10-13T13:00:00+09:00',
    });
    expect(q.attempts[1]).toMatchObject({ state: 'inprogress', grade: null, finishedAt: null });
  });

  it('hides attempt marks the review options hide, and maps unlimited / no limit to null', () => {
    const q = mapQuiz(
      { ...quizRaw, reviewmarks: 0, attempts: 0, timelimit: 0 },
      quizAttempts,
      { hasgrade: false },
      base,
    );
    expect(q.attempts[0]?.grade).toBeNull();
    expect(q.attemptsAllowed).toBeNull();
    expect(q.timeLimitMinutes).toBeNull();
    expect(q.bestGrade).toBeNull();
  });

  it('uses the after-close phase once the quiz is closed', () => {
    const closed = { ...base, now: 1793000000 };
    expect(mapQuiz(quizRaw, quizAttempts, null, closed).attempts[0]?.grade).toBeNull(); // 0x100 only
    expect(mapQuiz({ ...quizRaw, reviewmarks: 0x10 }, quizAttempts, null, closed).attempts[0]?.grade).toBe('7.5 / 10');
  });
});

describe('content mappers', () => {
  it('keeps folder sub-paths in file names', () => {
    const files = mapContentFiles(folderModule.contents);
    expect(files.map((f) => f.name)).toEqual(['a.pdf', 'data/b.xlsx']);
    expect(files[0]?.url).toContain('/webservice/pluginfile.php/555/');
  });
  it('renders the book structure as an indented list', () => {
    expect(mapBookStructure(bookModule.contents)).toBe('- Chapter 1\n  - Section 1.1\n- Q&A');
    expect(mapBookStructure([])).toBeNull();
  });
});

describe('getActivity', () => {
  it('assign: 3 Moodle calls and the instance id for the status call', async () => {
    const { ctx, calls } = makeFakeContext({
      core_course_get_course_module: cmOf(7001, 'assign', 5001),
      mod_assign_get_assignments: { courses: [{ id: 9001, assignments: [assignRaw] }], warnings: [] },
      mod_assign_get_submission_status: assignStatusDraft,
    });
    const a = (await getActivity(ctx, 7001)) as AssignDetail;
    expect(a.type).toBe('assign');
    expect(a.courseName).toBe('Corporate Finance Basics');
    expect(a.url).toBe(`${FAKE_BASE_URL}/mod/assign/view.php?id=7001`);
    expect(a.submission.status).toBe('draft');
    expect(calls.map((c) => c.fn)).toEqual([
      'core_course_get_course_module',
      'mod_assign_get_assignments',
      'mod_assign_get_submission_status',
    ]);
    expect(calls[1]?.params).toEqual({ courseids: [9001] });
    expect(calls[2]?.params).toEqual({ assignid: 5001 });
  });

  it('assign: a failing status call still returns the settings', async () => {
    const { ctx } = makeFakeContext({
      core_course_get_course_module: cmOf(7001, 'assign', 5001),
      mod_assign_get_assignments: { courses: [{ id: 9001, assignments: [assignRaw] }] },
      mod_assign_get_submission_status: () => {
        throw new MoodleError('No permission', 'nopermission');
      },
    });
    const a = (await getActivity(ctx, 7001)) as AssignDetail;
    expect(a.name).toBe('Report 1 & Case');
    expect(a.submission).toMatchObject({ status: 'none', canEdit: false });
  });

  it('throws NotFound for an unknown cmid and for a missing assignment row', async () => {
    const missing = makeFakeContext({
      core_course_get_course_module: () => {
        throw new MoodleError('Can not find data record', 'invalidrecord');
      },
    });
    await expect(getActivity(missing.ctx, 1)).rejects.toBeInstanceOf(NotFound);

    const noRow = makeFakeContext({
      core_course_get_course_module: cmOf(7099, 'assign', 1),
      mod_assign_get_assignments: { courses: [{ id: 9001, assignments: [assignRaw] }] },
    });
    await expect(getActivity(noRow.ctx, 7099)).rejects.toBeInstanceOf(NotFound);
  });

  it('quiz: prefers the new attempts function, falls back to the old one, ignores best-grade errors', async () => {
    const handlers = {
      core_course_get_course_module: cmOf(7002, 'quiz', 6001),
      mod_quiz_get_quizzes_by_courses: { quizzes: [quizRaw], warnings: [] },
      mod_quiz_get_user_quiz_attempts: { attempts: quizAttempts },
      mod_quiz_get_user_best_grade: quizBest,
    };
    const ok = makeFakeContext(handlers);
    const q = (await getActivity(ok.ctx, 7002)) as QuizDetail;
    expect(q.attempts).toHaveLength(2);
    expect(q.bestGrade).toBe('7.5 / 10');
    expect(ok.calls).toHaveLength(4); // course module, quizzes, attempts, best grade (course names are a separate listCourses call)
    expect(ok.calls[2]?.params).toEqual({ quizid: 6001, status: 'all', includepreviews: false });

    const legacy = makeFakeContext({
      ...handlers,
      mod_quiz_get_user_quiz_attempts: () => {
        throw new MoodleError('Function not found', 'invalidrecord');
      },
      mod_quiz_get_user_attempts: { attempts: quizAttempts },
      mod_quiz_get_user_best_grade: () => {
        throw new MoodleError('nope', 'accessexception');
      },
    });
    const q2 = (await getActivity(legacy.ctx, 7002)) as QuizDetail;
    expect(q2.attempts).toHaveLength(2);
    expect(q2.bestGrade).toBeNull();
    expect(countCalls(legacy.calls, 'mod_quiz_get_user_attempts')).toBe(1);
  });

  it('forum: latest 10 discussions via mod_forum; skips the call for empty forums', async () => {
    const { ctx, calls } = makeFakeContext({
      core_course_get_course_module: cmOf(7010, 'forum', 3001),
      mod_forum_get_forums_by_courses: forumsC1,
      mod_forum_get_forum_discussions: forumDiscussions,
    });
    const f = (await getActivity(ctx, 7010)) as ForumDetail;
    expect(f).toMatchObject({ type: 'forum', forumType: 'forum', forumId: 3001, name: 'Announcements', cmid: 7010 });
    expect(f.description).toContain('News & updates');
    expect(f.discussions.map((d) => d.discussionId)).toEqual([701, 702]);
    expect(calls.at(-1)).toEqual({
      fn: 'mod_forum_get_forum_discussions',
      params: { forumid: 3001, sortorder: -1, page: 0, perpage: 10 },
    });

    const empty = makeFakeContext({
      core_course_get_course_module: cmOf(7011, 'forum', 3002),
      mod_forum_get_forums_by_courses: forumsC1,
    });
    expect(((await getActivity(empty.ctx, 7011)) as ForumDetail).discussions).toEqual([]);
    expect(countCalls(empty.calls, 'mod_forum_get_forum_discussions')).toBe(0);
  });

  it('forum: unreadable discussions leave an empty list instead of failing', async () => {
    const { ctx } = makeFakeContext({
      core_course_get_course_module: cmOf(7010, 'forum', 3001),
      mod_forum_get_forums_by_courses: forumsC1,
      mod_forum_get_forum_discussions: () => {
        throw new MoodleError('No permission', 'noviewdiscussionspermission');
      },
    });
    const f = (await getActivity(ctx, 7010)) as ForumDetail;
    expect(f.name).toBe('Announcements');
    expect(f.discussions).toEqual([]);
  });

  it('hsuforum: uses the mod_hsuforum functions', async () => {
    const { ctx, calls } = makeFakeContext({
      core_course_get_course_module: cmOf(7020, 'hsuforum', 4001),
      mod_hsuforum_get_forums_by_courses: hsuForumsC1,
      mod_hsuforum_get_forum_discussions_paginated: hsuDiscussions,
    });
    const f = (await getActivity(ctx, 7020)) as ForumDetail;
    expect(f).toMatchObject({ forumType: 'hsuforum', forumId: 4001, dueAt: '2026-10-20T23:59:00+09:00' });
    expect(f.discussions[0]).toMatchObject({ forumType: 'hsuforum', discussionId: 751, replies: 2, unread: 2 });
    expect(calls.at(-1)?.params).toEqual({
      forumid: 4001,
      sortby: 'timemodified',
      sortdirection: 'DESC',
      page: 0,
      perpage: 10,
    });
  });

  it('page: body and files from mod_page (3 calls)', async () => {
    const { ctx, calls } = makeFakeContext({
      core_course_get_course_module: cmOf(7003, 'page', 1),
      mod_page_get_pages_by_courses: { pages: [pageRaw], warnings: [] },
    });
    const p = (await getActivity(ctx, 7003)) as ContentDetail;
    expect(p).toMatchObject({ type: 'content', modname: 'page', name: 'Syllabus & Schedule', externalUrl: null });
    expect(p.body).toContain('Week 1');
    expect(p.body).toContain('Reading A');
    expect(p.files.map((f) => f.name)).toEqual(['schedule.png']);
    expect(calls).toHaveLength(2);
  });

  it('url: external url from mod_url', async () => {
    const { ctx } = makeFakeContext({
      core_course_get_course_module: cmOf(7004, 'url', 1),
      mod_url_get_urls_by_courses: { urls: [urlRaw] },
    });
    const u = (await getActivity(ctx, 7004)) as ContentDetail;
    expect(u.externalUrl).toBe('https://library.example.com/list');
    expect(u.body).toBeNull();
  });

  it('label, book and folder come from core_course_get_contents with the cmid option', async () => {
    const sections = [{ id: 1, modules: [labelModule, bookModule, folderModule] }];
    const mk = (cmid: number, modname: string) =>
      makeFakeContext({ core_course_get_course_module: cmOf(cmid, modname, 1), core_course_get_contents: sections });

    const l = mk(7005, 'label');
    const label = (await getActivity(l.ctx, 7005)) as ContentDetail;
    expect(label.body).toContain('Exam');
    expect(label.description).toBe('');
    expect(l.calls.at(-1)).toEqual({
      fn: 'core_course_get_contents',
      params: { courseid: 9001, options: [{ name: 'cmid', value: 7005 }] },
    });

    const book = (await getActivity(mk(7006, 'book').ctx, 7006)) as ContentDetail;
    expect(book.body).toBe('- Chapter 1\n  - Section 1.1\n- Q&A');
    expect(book.files).toEqual([]);

    const folder = (await getActivity(mk(7007, 'folder').ctx, 7007)) as ContentDetail;
    expect(folder.files.map((f) => f.name)).toEqual(['a.pdf', 'data/b.xlsx']);
    expect(folder.body).toBeNull();
  });

  it('falls back to core_course_get_contents when the page row is missing', async () => {
    const { ctx } = makeFakeContext({
      core_course_get_course_module: cmOf(7006, 'page', 1),
      mod_page_get_pages_by_courses: { pages: [] },
      core_course_get_contents: [{ id: 1, modules: [{ ...bookModule, id: 7006, modname: 'page' }] }],
    });
    const c = (await getActivity(ctx, 7006)) as ContentDetail;
    expect(c.type).toBe('content');
  });

  it('throws NotFound when the module is not in the contents', async () => {
    const { ctx } = makeFakeContext({
      core_course_get_course_module: cmOf(7050, 'resource', 1),
      core_course_get_contents: [{ id: 1, modules: [] }],
    });
    await expect(getActivity(ctx, 7050)).rejects.toBeInstanceOf(NotFound);
  });
});
