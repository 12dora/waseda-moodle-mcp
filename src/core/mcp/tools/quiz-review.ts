import * as z from 'zod';
import { getQuizReview } from '../../services/quiz-review';
import { renderQuizReview } from '../render/quiz-review';
import { quizReviewOut } from '../schemas/quiz-review';
import { defineTool, id, READ_HINTS } from './define';

const getQuizReviewTool = defineTool({
  name: 'get_quiz_review',
  title: 'Quiz review',
  description:
    'Reviews a finished quiz attempt of the user: the list of finished attempts with their grades and, for one attempt (default: the latest), ' +
    "every question with its marks, the user's answer, the right answer and the teacher's feedback, as far as the quiz's review options let Moodle show them. " +
    'Use it to study mistakes after a quiz. Questions answered correctly are shown on one line. ' +
    'It is read only: it never starts, continues or submits an attempt, and the user must take quizzes in Moodle themselves. ' +
    'Pass the cmid of the quiz (from get_due_items, get_course or get_activity).',
  annotations: READ_HINTS,
  input: z.object({
    cmid: id('Course module id (cmid) of the quiz.'),
    attempt: id('Attempt number to review (1 = first). Default: the latest finished attempt.').optional(),
  }),
  output: quizReviewOut,
  async run(ctx, a) {
    const r = await getQuizReview(ctx, { cmid: a.cmid, attempt: a.attempt });
    return { text: renderQuizReview(r), data: r };
  },
});

export const quizReviewTools = [getQuizReviewTool];
