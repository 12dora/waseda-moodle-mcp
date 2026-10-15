import * as z from 'zod';

export const syllabusOut = z.looseObject({
  courseId: z.number(),
  courseName: z.string(),
  status: z.string(),
  requestedLang: z.string(),
  /** The parsed public page; null unless status is 'ok'. */
  page: z.looseObject({ lang: z.string() }).nullable(),
  url: z.string().nullable(),
  searchUrl: z.string(),
});
