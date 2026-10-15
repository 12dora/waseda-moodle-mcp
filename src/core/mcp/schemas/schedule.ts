import * as z from 'zod';
import { list } from './common';

/** `schedule` is null when the saved times were removed (mode 'auto'). */
export const courseScheduleOut = z.looseObject({
  courseId: z.number(),
  schedule: z
    .looseObject({
      mode: z.string(),
      slots: list({ weekday: z.number(), periodFrom: z.number(), periodTo: z.number() }),
      alsoOnDemand: z.boolean(),
    })
    .nullable(),
});
