import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, NeedsReconnect, NotFound } from '../../src/core/errors';
import { getQuizReview, mapReviewQuestion } from '../../src/core/services/quiz-review';
import { quizBest, quizRaw, urlRaw } from '../fixtures/be3/activity';
import {
  essayPending,
  hiddenOptions,
  matchPartial,
  multichoiceRight,
  reviewAttempts,
  reviewPayload,
  shortanswerWrong,
} from '../fixtures/quiz-review';
import { countCalls, makeFakeContext } from '../helpers/fake-context-be3';

vi.mock('../../src/core/services/courses', () => ({
  listAllCourses: vi.fn(async () => [{ id: 9001, name: 'Corporate Finance Basics' }]),
}));

// 2026-10-14 10:30 JST: after both finished attempts, inside the quiz's open window
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T10:30:00+09:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

const cmOf = (id: number, modname: string, instance: number) => ({
  cm: { id, course: 9001, modname, instance, name: 'ignored' },
  warnings: [],
});

const quizHandlers = (extra: Record<string, unknown> = {}) => ({
  core_course_get_course_module: cmOf(7002, 'quiz', 6001),
  mod_quiz_get_quizzes_by_courses: { quizzes: [quizRaw], warnings: [] },
  mod_quiz_get_user_quiz_attempts: { attempts: reviewAttempts },
  mod_quiz_get_user_best_grade: quizBest,
  mod_quiz_get_attempt_review: reviewPayload,
  ...extra,
});

describe('mapReviewQuestion', () => {
  it('multiple choice: question text, marked options, right answer, feedback; no widgets or JS', () => {
    const q = mapReviewQuestion(multichoiceRight);
    expect(q).toMatchObject({ number: '1', type: 'multichoice', state: 'gradedright', mark: 1, maxMark: 1 });
    expect(q.text).toBe('Which city is the capital of France?');
    expect(q.answer).toBe('[x] a. Paris ✓\n[ ] b. Berlin\n[ ] c. Madrid');
    expect(q.rightAnswer).toBe('The correct answer is: Paris');
    expect(q.feedback).toBe('Your answer is correct.');
    for (const part of [q.text, q.answer, q.rightAnswer ?? '', q.feedback ?? '']) {
      expect(part).not.toMatch(/<|require|flagged|Question text|Answer$/);
    }
  });

  it('short answer: the typed value is shown, specific and general feedback are both kept', () => {
    const q = mapReviewQuestion(shortanswerWrong);
    expect(q).toMatchObject({ state: 'gradedwrong', mark: 0, maxMark: 1 });
    expect(q.text).toContain('The capital of Japan is:');
    expect(q.answer).toContain('⟦Kyoto⟧');
    expect(q.answer).toContain('✗');
    expect(q.answer).not.toContain('Answer');
    expect(q.rightAnswer).toBe('The correct answer is: Tokyo');
    expect(q.feedback).toContain('Your answer is incorrect.');
    expect(q.feedback).toContain('Tokyo has been the capital since 1868.');
  });

  it('match: selected options of each row, partial mark parsed from a string', () => {
    const q = mapReviewQuestion(matchPartial);
    expect(q).toMatchObject({ state: 'gradedpartial', mark: 0.5, maxMark: 1 });
    expect(q.answer).toContain('France');
    expect(q.answer).toContain('⟦Paris⟧');
    expect(q.answer).toContain('⟦Madrid⟧');
    expect(q.answer).not.toContain('Choose');
    expect(q.rightAnswer).toBe('France → Paris, Italy → Rome');
  });

  it('essay: the response text, no mark yet, nothing else', () => {
    const q = mapReviewQuestion(essayPending);
    expect(q).toMatchObject({ type: 'essay', state: 'needsgrading', mark: null, maxMark: 5 });
    expect(q.answer).toBe('Discount the face value.\n\nUse the yield to maturity.');
    expect(q.rightAnswer).toBeNull();
    expect(q.feedback).toBeNull();
  });

  it('hidden review options: no marks, right answer or feedback; unnumbered choices stay on one line', () => {
    const q = mapReviewQuestion(hiddenOptions);
    expect(q).toMatchObject({ mark: null, maxMark: 1, rightAnswer: null, feedback: null });
    expect(q.answer).toBe('[x] True\n[ ] False');
  });

  it('survives empty or foreign html', () => {
    const empty = { number: '', text: '', answer: '', rightAnswer: null, feedback: null };
    expect(mapReviewQuestion({})).toMatchObject(empty);
    const html = '<p>Just <b>info</b></p><script>x()</script>';
    expect(mapReviewQuestion({ type: 'description', number: 7, html })).toMatchObject({
      number: '7',
      text: '',
      answer: 'Just info',
    });
  });

  it('caps very long questions', () => {
    const long = 'word '.repeat(5000);
    const q = mapReviewQuestion({
      html: `<div class="que"><div class="formulation"><div class="qtext"><p>${long}</p></div></div></div>`,
    });
    expect(q.text.length).toBeLessThanOrEqual(1500);
  });
});

describe('getQuizReview', () => {
  it('reviews the latest finished attempt and lists the finished ones with grades', async () => {
    const { ctx, calls } = makeFakeContext(quizHandlers());
    const r = await getQuizReview(ctx, { cmid: 7002 });
    expect(r).toMatchObject({
      cmid: 7002,
      quizId: 6001,
      courseId: 9001,
      courseName: 'Corporate Finance Basics',
      name: 'Midterm Quiz',
      reviewedAttempt: 2,
      note: null,
    });
    expect(r.attempts.map((a) => [a.attempt, a.grade])).toEqual([
      [1, '7.5 / 10'],
      [2, '9 / 10'],
    ]);
    expect(r.questions.map((q) => q.type)).toEqual(['multichoice', 'shortanswer', 'match', 'essay']);
    expect(calls.find((c) => c.fn === 'mod_quiz_get_attempt_review')?.params).toEqual({ attemptid: 502, page: -1 });
  });

  it('reviews the attempt that was asked for', async () => {
    const { ctx, calls } = makeFakeContext(quizHandlers());
    const r = await getQuizReview(ctx, { cmid: 7002, attempt: 1 });
    expect(r.reviewedAttempt).toBe(1);
    expect(calls.find((c) => c.fn === 'mod_quiz_get_attempt_review')?.params).toEqual({ attemptid: 501, page: -1 });
  });

  it('never reviews an attempt that is unfinished or unknown', async () => {
    const { ctx, calls } = makeFakeContext(quizHandlers());
    await expect(getQuizReview(ctx, { cmid: 7002, attempt: 3 })).rejects.toThrow(/finished: 1, 2/);
    await expect(getQuizReview(ctx, { cmid: 7002, attempt: 9 })).rejects.toBeInstanceOf(NotFound);
    expect(countCalls(calls, 'mod_quiz_get_attempt_review')).toBe(0);
  });

  it('says so when there is no finished attempt, without asking Moodle for a review', async () => {
    const inProgress = reviewAttempts.filter((a) => a.state !== 'finished');
    const { ctx, calls } = makeFakeContext(quizHandlers({ mod_quiz_get_user_quiz_attempts: { attempts: inProgress } }));
    const r = await getQuizReview(ctx, { cmid: 7002 });
    expect(r).toMatchObject({ attempts: [], reviewedAttempt: null, questions: [] });
    expect(r.note).toContain('No finished attempt');
    expect(countCalls(calls, 'mod_quiz_get_attempt_review')).toBe(0);
  });

  it('turns a Moodle refusal into a note and lets connection errors through', async () => {
    const refused = makeFakeContext(
      quizHandlers({
        mod_quiz_get_attempt_review: () => {
          throw new MoodleError('You are not allowed to review this attempt', 'noreview');
        },
      }),
    );
    const r = await getQuizReview(refused.ctx, { cmid: 7002 });
    expect(r.questions).toEqual([]);
    expect(r.reviewedAttempt).toBe(2);
    expect(r.note).toContain('not allowed to review');

    const expired = makeFakeContext(
      quizHandlers({
        mod_quiz_get_attempt_review: () => {
          throw new NeedsReconnect();
        },
      }),
    );
    await expect(getQuizReview(expired.ctx, { cmid: 7002 })).rejects.toBeInstanceOf(NeedsReconnect);
  });

  it('refuses activities that are not quizzes', async () => {
    const { ctx } = makeFakeContext({
      core_course_get_course_module: cmOf(7004, 'url', 1),
      mod_url_get_urls_by_courses: { urls: [urlRaw] },
    });
    await expect(getQuizReview(ctx, { cmid: 7004 })).rejects.toBeInstanceOf(InvalidInput);
  });

  it('keeps at most 60 questions and says that it cut the rest', async () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ ...essayPending, questionnumber: String(i + 1) }));
    const { ctx } = makeFakeContext(quizHandlers({ mod_quiz_get_attempt_review: { questions: many } }));
    const r = await getQuizReview(ctx, { cmid: 7002 });
    expect(r.questions).toHaveLength(60);
    expect(r.note).toContain('first 60 of 65');
  });

  it('falls back to the pre-5.0 attempts function', async () => {
    const { ctx, calls } = makeFakeContext(
      quizHandlers({
        mod_quiz_get_user_quiz_attempts: () => {
          throw new MoodleError('Unknown function', 'invalidrecord');
        },
        mod_quiz_get_user_attempts: { attempts: reviewAttempts },
      }),
    );
    const r = await getQuizReview(ctx, { cmid: 7002 });
    expect(r.reviewedAttempt).toBe(2);
    expect(r.questions).toHaveLength(4);
    expect(countCalls(calls, 'mod_quiz_get_user_attempts')).toBeGreaterThanOrEqual(1); // the real client's request memo answers the repeat
  });

  describe('long quizzes', () => {
    /** Moodle layout: question slots, a 0 after each page. */
    const layoutOf = (questions: number, perPage: number) => {
      const slots: string[] = [];
      for (let q = 1; q <= questions; q++) {
        slots.push(String(q));
        if (q % perPage === 0 || q === questions) slots.push('0');
      }
      return slots.join(',');
    };
    const reviewPages = (calls: { fn: string; params: Record<string, unknown> }[]) =>
      calls.filter((c) => c.fn === 'mod_quiz_get_attempt_review').map((c) => c.params.page);
    const pageHandler = (perPage: number) => (params: Record<string, unknown>) => {
      const page = Number(params.page);
      return {
        questions: Array.from({ length: perPage }, (_, i) => ({
          ...essayPending,
          questionnumber: String(page * perPage + i + 1),
        })),
      };
    };
    const attemptsWith = (layout: string) => ({
      attempts: reviewAttempts.map((a) => ({ ...a, layout })),
    });

    it('reads pages one by one and stops once 60 questions are in', async () => {
      const { ctx, calls } = makeFakeContext(
        quizHandlers({
          mod_quiz_get_user_quiz_attempts: attemptsWith(layoutOf(200, 25)),
          mod_quiz_get_attempt_review: pageHandler(25),
        }),
      );
      const r = await getQuizReview(ctx, { cmid: 7002 });
      expect(reviewPages(calls)).toEqual([0, 1, 2]);
      expect(r.questions).toHaveLength(60);
      expect(r.questions.at(-1)?.number).toBe('60');
      expect(r.note).toBe('Only the first 60 of 200 questions are included.');
    });

    it('limits the number of page calls for quizzes with one question per page', async () => {
      const { ctx, calls } = makeFakeContext(
        quizHandlers({
          mod_quiz_get_user_quiz_attempts: attemptsWith(layoutOf(100, 1)),
          mod_quiz_get_attempt_review: pageHandler(1),
        }),
      );
      const r = await getQuizReview(ctx, { cmid: 7002 });
      expect(countCalls(calls, 'mod_quiz_get_attempt_review')).toBe(12);
      expect(r.questions).toHaveLength(12);
      expect(r.note).toBe('Only the first 12 of 100 questions are included.');
    });

    it('reads a quiz that fits the cap in one call, with or without a layout', async () => {
      for (const layout of [layoutOf(4, 2), 'x,y']) {
        const { ctx, calls } = makeFakeContext(quizHandlers({ mod_quiz_get_user_quiz_attempts: attemptsWith(layout) }));
        await getQuizReview(ctx, { cmid: 7002 });
        expect(reviewPages(calls)).toEqual([-1]);
      }
    });
  });
});
