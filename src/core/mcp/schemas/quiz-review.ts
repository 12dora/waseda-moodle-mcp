import * as z from 'zod';
import { list } from './common';

export const quizReviewOut = z.looseObject({
  cmid: z.number(),
  quizId: z.number(),
  courseId: z.number(),
  courseName: z.string(),
  name: z.string(),
  url: z.string(),
  attempts: list({ attempt: z.number(), state: z.string() }),
  reviewedAttempt: z.number().nullable(),
  questions: list({ number: z.string(), type: z.string(), state: z.string(), text: z.string(), answer: z.string() }),
  note: z.string().nullable(),
});
