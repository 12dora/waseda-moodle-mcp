import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { quizFunctions } from '../../../../src/core/moodle/web/adapters/quiz';
import type { WebSession } from '../../../../src/core/moodle/web/types';
import {
  mapQuiz,
  type RawBestGrade,
  type RawQuiz,
  type RawQuizAttempt,
} from '../../../../src/core/services/activity/quiz';
import { parseQuizState } from '../../../../src/core/services/submission/quiz';
import { makeFakeWebSession } from '../../../helpers/fake-web-session';

vi.mock('../../../../src/core/moodle/web/parse/overview', () => ({
  readOverview: vi.fn(async () => {
    return new Map([
      [7101, { values: { name: '語彙テスト１', duedate: '1798124340', 評点: '24.00000' }, text: {} }],
      [7103, { values: { name: '文法テスト', duedate: '' }, text: {} }],
    ]);
  }),
}));

const fixture = (name: string) => readFileSync(join(__dirname, '../../../fixtures/web', name), 'utf8');

/** Unix seconds of a Tokyo wall-clock time. */
const jst = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - 9, mi) / 1000;

const VIEW = {
  '/mod/quiz/view.php?id=7101': fixture('quiz-view-ja.html'),
  '/mod/quiz/view.php?id=7102': fixture('quiz-view-en.html'),
  '/mod/quiz/view.php?id=7103': fixture('quiz-view-closed-ja.html'),
};

function session(pages: Record<string, string> = VIEW): WebSession {
  return makeFakeWebSession({ pages });
}

const call = (web: WebSession, fn: string, params: Record<string, unknown>, cmid?: number) => {
  const impl = quizFunctions[fn];
  if (!impl) throw new Error(`no adapter for ${fn}`);
  return impl(web, params, cmid ? { cmid } : {}) as Promise<Record<string, unknown>>;
};

type Quizzes = { quizzes: RawQuiz[] };
type Attempts = { attempts: RawQuizAttempt[] };

describe('mod_quiz_get_quizzes_by_courses (web)', () => {
  it('reads the settings of the hinted quiz (ja: marks and grade rows, limited attempts)', async () => {
    const res = (await call(session(), 'mod_quiz_get_quizzes_by_courses', { courseids: [99101] }, 7101)) as Quizzes;
    expect(res.quizzes).toEqual([
      {
        id: 7101,
        coursemodule: 7101,
        course: 99101,
        name: '語彙テスト１',
        intro: '<div class="no-overflow"><p>期限までに受験してください。</p></div>',
        timeopen: jst(2026, 10, 1, 9, 0),
        timeclose: jst(2026, 12, 24, 23, 59),
        timelimit: 5400,
        attempts: 3,
        grade: 30,
        sumgrades: 10,
        decimalpoints: 2,
        grademethod: 1,
        reviewmarks: 0x11110,
      },
    ]);
  });

  it('reads an unlimited quiz without separate marks (en)', async () => {
    const res = (await call(session(), 'mod_quiz_get_quizzes_by_courses', { courseids: [99102] }, 7102)) as Quizzes;
    expect(res.quizzes[0]).toMatchObject({
      course: 99102,
      name: 'Vocabulary practice',
      timeopen: jst(2026, 10, 1, 9, 0),
      timeclose: jst(2026, 12, 24, 23, 59),
      timelimit: 2700,
      attempts: 0,
      grade: 30,
      sumgrades: 30,
      decimalpoints: 0,
      grademethod: 4,
    });
  });

  it('marks hidden: reviewmarks 0, no grade, closed date', async () => {
    const res = (await call(session(), 'mod_quiz_get_quizzes_by_courses', { courseids: [99101] }, 7103)) as Quizzes;
    expect(res.quizzes[0]).toMatchObject({
      timeopen: 0,
      timeclose: jst(2026, 10, 8, 23, 59),
      attempts: 1,
      grade: null,
      sumgrades: null,
      reviewmarks: 0,
    });
  });

  it('returns nothing when the hinted quiz belongs to another course', async () => {
    const res = (await call(session(), 'mod_quiz_get_quizzes_by_courses', { courseids: [99999] }, 7101)) as Quizzes;
    expect(res.quizzes).toEqual([]);
  });

  it('lists a course from the activity overview without a hint (no max grade there)', async () => {
    const res = (await call(session({}), 'mod_quiz_get_quizzes_by_courses', { courseids: [99101] })) as Quizzes;
    expect(res.quizzes).toEqual([
      { id: 7101, coursemodule: 7101, course: 99101, name: '語彙テスト１', timeclose: 1798124340, grade: null },
      { id: 7103, coursemodule: 7103, course: 99101, name: '文法テスト', timeclose: 0, grade: null },
    ]);
  });
});

describe('mod_quiz_get_user_quiz_attempts (web)', () => {
  it('reads finished attempts with ids, dates and raw marks (ja)', async () => {
    const web = session();
    const res = (await call(web, 'mod_quiz_get_user_quiz_attempts', { quizid: 7101, status: 'all' })) as Attempts;
    expect(res.attempts).toEqual([
      {
        id: 5001,
        attempt: 1,
        state: 'finished',
        timestart: jst(2026, 10, 5, 10, 0),
        timefinish: jst(2026, 10, 5, 10, 20),
        sumgrades: 6,
        preview: false,
      },
      {
        id: 5002,
        attempt: 2,
        state: 'finished',
        timestart: jst(2026, 10, 6, 10, 0),
        timefinish: jst(2026, 10, 6, 10, 25),
        sumgrades: 8,
        preview: false,
      },
    ]);
  });

  it('reads an in-progress attempt and filters by status (en)', async () => {
    const web = session();
    const all = (await call(web, 'mod_quiz_get_user_attempts', { quizid: 7102, status: 'all' })) as Attempts;
    expect(all.attempts.map((a) => [a.attempt, a.state, a.id, a.sumgrades])).toEqual([
      [1, 'finished', 5011, 24],
      [2, 'inprogress', 5012, null],
    ]);
    expect(all.attempts[1]).toMatchObject({ timestart: jst(2026, 10, 6, 21, 0), timefinish: 0 });
    const params = { quizid: 7102, status: 'unfinished' };
    const open = (await call(web, 'mod_quiz_get_user_quiz_attempts', params)) as Attempts;
    expect(open.attempts.map((a) => a.attempt)).toEqual([2]);
    const done = (await call(web, 'mod_quiz_get_user_quiz_attempts', { quizid: 7102 })) as Attempts;
    expect(done.attempts.map((a) => a.attempt)).toEqual([1]);
  });

  it('keeps an attempt without a review link and without marks', async () => {
    const web = session();
    const res = (await call(web, 'mod_quiz_get_user_quiz_attempts', { quizid: 7103, status: 'all' })) as Attempts;
    const only = { id: null, attempt: 1, state: 'finished', sumgrades: null };
    expect(res.attempts).toEqual([expect.objectContaining(only)]);
  });

  it('refuses a missing quizid', async () => {
    await expect(call(session(), 'mod_quiz_get_user_quiz_attempts', { status: 'all' })).rejects.toMatchObject({
      errorcode: 'invalidparameter',
    });
  });
});

describe('mod_quiz_get_user_best_grade / access information (web)', () => {
  it('reads the final grade line (ja and en)', async () => {
    const web = session();
    const best = (quizid: number) => call(web, 'mod_quiz_get_user_best_grade', { quizid });
    expect(await best(7101)).toMatchObject({ hasgrade: true, grade: 24 });
    expect(await best(7102)).toMatchObject({ hasgrade: true, grade: 24 });
    expect(await best(7103)).toMatchObject({ hasgrade: false });
  });

  it('no reasons when the page has a start / continue button', async () => {
    const web = session();
    for (const quizid of [7101, 7102]) {
      const res = await call(web, 'mod_quiz_get_attempt_access_information', { quizid });
      expect(res.preventnewattemptreasons).toEqual([]);
    }
  });

  it('the notices of a closed quiz are the reasons', async () => {
    const res = await call(session(), 'mod_quiz_get_attempt_access_information', { quizid: 7103 });
    expect(res.preventnewattemptreasons).toEqual([
      'この小テストは終了しました。',
      'これ以上の受験は許可されていません。',
    ]);
  });

  it('a generic reason when there is no button and no notice', async () => {
    const html = fixture('quiz-view-closed-ja.html').replace(/<p class="text-start">こ[のれ][^<]*<\/p>/g, '');
    const web = session({ '/mod/quiz/view.php?id=7104': html });
    const res = await call(web, 'mod_quiz_get_attempt_access_information', { quizid: 7104 });
    expect(res.preventnewattemptreasons).toEqual(['No new attempt can be started on this quiz.']);
  });
});

describe('mod_quiz_get_attempt_review (web)', () => {
  it('reads every question of the attempt with showall (ja)', async () => {
    const web = session({ '/mod/quiz/review.php?attempt=5002&showall=1': fixture('quiz-review-ja.html') });
    const res = (await call(web, 'mod_quiz_get_attempt_review', { attemptid: 5002, page: -1 })) as {
      questions: Array<Record<string, unknown>>;
    };
    expect(res.questions.map(({ html: _html, ...q }) => q)).toEqual([
      {
        slot: 1,
        type: 'multichoice',
        number: 1,
        questionnumber: '1',
        state: 'gradedright',
        status: '正解',
        mark: 1,
        maxmark: 1,
      },
      {
        slot: 2,
        type: 'shortanswer',
        number: 2,
        questionnumber: '2',
        state: 'gradedwrong',
        status: '不正解',
        mark: 0,
        maxmark: 2,
      },
      {
        slot: 3,
        type: 'description',
        number: null,
        questionnumber: 'i',
        state: 'complete',
        status: '',
        mark: null,
        maxmark: null,
      },
    ]);
    const first = String(res.questions[0]?.html);
    expect(first.startsWith('<div id="question-6001-1"')).toBe(true);
    expect(first).toContain('<div class="rightanswer">正解: apple</div>');
    expect(first).not.toContain('question-6001-2');
  });

  it('reads one page without showall (en: partial mark, ungraded essay)', async () => {
    const web = session({ '/mod/quiz/review.php?attempt=5011&page=1&showall=0': fixture('quiz-review-en.html') });
    const res = (await call(web, 'mod_quiz_get_attempt_review', { attemptid: 5011, page: 1 })) as {
      questions: Array<Record<string, unknown>>;
    };
    expect(res.questions.map((q) => [q.slot, q.type, q.state, q.status, q.mark, q.maxmark])).toEqual([
      [4, 'multianswer', 'gradedpartial', 'Partially correct', 1.5, 2],
      [5, 'essay', 'needsgrading', 'Requires grading', null, 5],
    ]);
  });
});

describe('services on top of the web adapters', () => {
  const now = jst(2026, 11, 27, 12, 0);

  it('mapQuiz shows the scaled attempt grades and the best grade', async () => {
    const web = session();
    const { quizzes } = (await call(web, 'mod_quiz_get_quizzes_by_courses', { courseids: [99101] }, 7101)) as Quizzes;
    const params = { quizid: 7101, status: 'all' };
    const { attempts } = (await call(web, 'mod_quiz_get_user_quiz_attempts', params)) as Attempts;
    const best = (await call(web, 'mod_quiz_get_user_best_grade', { quizid: 7101 })) as RawBestGrade;
    const quiz = quizzes[0];
    if (!quiz) throw new Error('no quiz');
    const url = 'https://wsdmoodle.waseda.jp/mod/quiz/view.php?id=7101';
    const info = { courseId: 99101, courseName: '総合日本語３Ｘ', url, lang: 'ja', now };
    const detail = mapQuiz(quiz, attempts, best, info);
    expect(detail.attempts.map((a) => a.grade)).toEqual(['18 / 30', '24 / 30']);
    expect(detail).toMatchObject({ bestGrade: '24 / 30', attemptsAllowed: 3, timeLimitMinutes: 90 });
  });

  it('parseQuizState: in progress (en) and closed (ja)', async () => {
    const web = session();
    const state = async (quizid: number) =>
      parseQuizState({
        attempts: await call(web, 'mod_quiz_get_user_quiz_attempts', { quizid, status: 'all' }),
        access: await call(web, 'mod_quiz_get_attempt_access_information', { quizid }),
      });
    expect(await state(7102)).toMatchObject({ status: 'in-progress', canContinue: true });
    expect(await state(7103)).toMatchObject({ status: 'submitted', canContinue: false });
  });
});
