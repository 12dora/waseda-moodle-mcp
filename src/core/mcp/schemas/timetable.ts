import * as z from 'zod';
import { list } from './common';

const courseRef = { courseId: z.number(), courseName: z.string(), url: z.string() };
const periodTimes = list({ period: z.number(), start: z.string(), end: z.string() });

export const timetableOut = z.looseObject({
  from: z.string(),
  to: z.string(),
  days: list({
    date: z.string(),
    weekday: z.number(),
    notes: list({ kind: z.string() }),
    classes: list({ ...courseRef, start: z.string(), end: z.string(), periods: z.string() }),
  }),
  onDemand: list({ ...courseRef, kind: z.string() }),
  unknown: list({ ...courseRef, reason: z.string() }),
  periodTimes: z.looseObject({ standard: periodTimes, evening: periodTimes }),
  scopeMode: z.string(),
  approximate: z.boolean(),
});
