import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_TEXT_CHARS } from '../../src/core/mcp/render/common';
import { renderQuizReview } from '../../src/core/mcp/render/quiz-review';
import { quizReviewTools } from '../../src/core/mcp/tools/quiz-review';
import { mapReviewQuestion, type QuizReview } from '../../src/core/services/quiz-review';
import { quizBest, quizRaw } from '../fixtures/be3/activity';
import { reviewAttempts, reviewPayload, reviewQuestions } from '../fixtures/quiz-review';
import { makeFakeContext } from '../helpers/fake-context-be3';

vi.mock('../../src/core/services/courses', () => ({
  listAllCourses: vi.fn(async () => [{ id: 9001, name: 'Corporate Finance Basics' }]),
}));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T10:30:00+09:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

const review = (patch: Partial<QuizReview> = {}): QuizReview => ({
  cmid: 7002,
  quizId: 6001,
  courseId: 9001,
  courseName: 'Corporate Finance Basics',
  name: 'Midterm Quiz',
  url: 'https://moodle.example.com/mod/quiz/view.php?id=7002',
  attempts: [
    { attempt: 1, state: 'finished', startedAt: null, finishedAt: '2026-10-13T13:00:00+09:00', grade: '7.5 / 10' },
    { attempt: 2, state: 'finished', startedAt: null, finishedAt: '2026-10-13T15:40:00+09:00', grade: null },
  ],
  reviewedAttempt: 2,
  questions: reviewQuestions.map(mapReviewQuestion),
  note: null,
  ...patch,
});

describe('renderQuizReview', () => {
  const text = renderQuizReview(review());

  it('heads with the quiz, the finished attempts and the attempt under review', () => {
    expect(text).toContain('# Midterm Quiz — quiz review (cmid 7002)');
    expect(text).toContain('Course: Corporate Finance Basics (course_id 9001)');
    expect(text).toContain('#1 finished 2026-10-13 Tue 13:00, grade 7.5 / 10; #2 finished 2026-10-13 Tue 15:40');
    expect(text).toContain('Reviewing attempt #2 (pass attempt to pick another).');
  });

  it('shows a right answer on one line and everything else in full', () => {
    expect(text).toContain('Q1 (multichoice) ✓ Correct · 1 / 1 — Which city is the capital of France?');
    expect(text).not.toContain('[x] a. Paris');
    expect(text).toContain('## Q2 (shortanswer) — Incorrect [gradedwrong] · 0 / 1');
    expect(text).toContain('Your answer:\n');
    expect(text).toContain('⟦Kyoto⟧');
    expect(text).toContain('Right answer: The correct answer is: Tokyo');
    expect(text).toContain('Feedback: Your answer is incorrect.');
    expect(text).toContain('## Q3 (match) — Partially correct [gradedpartial] · 0.5 / 1');
    expect(text).toContain('## Q4 (essay) — Requires grading [needsgrading] · ? / 5');
  });

  it('states that nothing is ever started or continued', () => {
    expect(text.trimEnd().endsWith('Review only: this server never starts or continues quiz attempts.')).toBe(true);
  });

  it('stays within the text cap and points at structuredContent when questions are dropped', () => {
    const wrong = { ...mapReviewQuestion(reviewQuestions[1] ?? {}), text: 'long question '.repeat(60) };
    const long = renderQuizReview(review({ questions: Array.from({ length: 40 }, () => wrong) }));
    expect(long.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 200);
    expect(long).toMatch(/… \d+ more \(the complete review is in structuredContent\)/);
  });

  it('explains an empty review', () => {
    const none = renderQuizReview(
      review({ attempts: [], reviewedAttempt: null, questions: [], note: 'No finished attempt yet.' }),
    );
    expect(none).toContain('No finished attempts.');
    expect(none).toContain('No finished attempt yet.');
    expect(none).not.toContain('Review only');
  });
});

describe('get_quiz_review tool', () => {
  const tool = quizReviewTools[0];
  const handlers = {
    core_course_get_course_module: { cm: { id: 7002, course: 9001, modname: 'quiz', instance: 6001, name: 'x' } },
    mod_quiz_get_quizzes_by_courses: { quizzes: [quizRaw] },
    mod_quiz_get_user_quiz_attempts: { attempts: reviewAttempts },
    mod_quiz_get_user_best_grade: quizBest,
    mod_quiz_get_attempt_review: reviewPayload,
  };

  it('is a read-only tool that takes a cmid and an optional attempt number', () => {
    expect(tool?.name).toBe('get_quiz_review');
    expect(tool?.annotations.readOnlyHint).toBe(true);
    expect(tool?.input.safeParse({ cmid: 7002 }).success).toBe(true);
    expect(tool?.input.safeParse({ cmid: 7002, attempt: 2 }).success).toBe(true);
    expect(tool?.input.safeParse({ cmid: 7002, attempt: 0 }).success).toBe(false);
    expect(tool?.input.safeParse({ attempt: 1 }).success).toBe(false);
  });

  it('returns the rendered text and the full review as structured data', async () => {
    const { ctx } = makeFakeContext(handlers);
    const out = await tool?.run(ctx, { cmid: 7002 });
    expect(out?.text).toContain('quiz review (cmid 7002)');
    expect(out?.text).toContain('Reviewing attempt #2');
    expect(out?.data).toMatchObject({ cmid: 7002, reviewedAttempt: 2 });
    expect((out?.data as QuizReview | undefined)?.questions).toHaveLength(4);
  });

  it('passes the attempt number on', async () => {
    const { ctx, calls } = makeFakeContext(handlers);
    await tool?.run(ctx, { cmid: 7002, attempt: 1 });
    expect(calls.find((c) => c.fn === 'mod_quiz_get_attempt_review')?.params).toEqual({ attemptid: 501, page: -1 });
  });
});
