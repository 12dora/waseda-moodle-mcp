import * as z from 'zod';
import { list } from './common';

/** The saved user settings. */
export const mySettingsOut = z.looseObject({
  writeMode: z.string(),
  myCourseIds: z.array(z.number()).nullable(),
  uiLang: z.string(),
  scheduleOverrides: z.record(z.string(), z.looseObject({})).optional(),
});

export const courseUpdatesOut = z.looseObject({
  updates: list({
    courseId: z.number(),
    courseName: z.string(),
    cmid: z.number(),
    name: z.string(),
    modname: z.string(),
    change: z.string(),
    at: z.string(),
    url: z.string(),
  }),
  stats: z.looseObject({ checked: z.number(), stale: z.number(), checkedAt: z.string().nullable() }),
});
