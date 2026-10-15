import * as z from 'zod';
import { list } from './common';

const dueItem = {
  kind: z.string(),
  courseId: z.number(),
  courseName: z.string(),
  cmid: z.number().nullable(),
  name: z.string(),
  dueAt: z.string().nullable(),
  overdue: z.boolean(),
  url: z.string(),
  submission: z.looseObject({ status: z.string(), canContinue: z.boolean() }).nullish(),
};

export const dueItemsOut = z.looseObject({
  generatedAt: z.string(),
  windowFrom: z.string(),
  windowTo: z.string(),
  items: list(dueItem),
  scope: z.looseObject({ mode: z.string(), courseIds: z.array(z.number()), otherCount: z.number() }),
  otherCourses: list(dueItem),
  sweep: z.looseObject({ checked: z.number(), stale: z.number(), checkedAt: z.string().nullable() }),
  truncated: z.boolean(),
});

const course = {
  id: z.number(),
  name: z.string(),
  shortName: z.string(),
  url: z.string(),
  kind: z.string(),
  mine: z.boolean(),
  suggested: z.boolean(),
};

export const listCoursesOut = z.looseObject({ courses: list(course), mode: z.string(), scope: z.string() });

const moduleSummary = { cmid: z.number(), name: z.string(), modname: z.string() };

export const courseOutlineOut = z.looseObject({
  course: z.looseObject(course),
  sections: list({ number: z.number(), name: z.string(), modules: list(moduleSummary) }),
});

export const searchContentOut = z.looseObject({
  hits: list({
    courseId: z.number(),
    courseName: z.string(),
    sectionName: z.string(),
    module: z.looseObject(moduleSummary),
  }),
  searchedCourses: z.number(),
  refreshed: z.number(),
  skipped: z.number(),
});

/** assign | quiz | content | forum: the keys every variant has. */
export const activityOut = z.looseObject({
  type: z.string(),
  cmid: z.number(),
  courseId: z.number(),
  courseName: z.string(),
  name: z.string(),
  url: z.string(),
});

/** Either `overview` (all courses) or `course` (one course), plus an optional note. */
export const gradesOut = z.looseObject({
  overview: list({ courseId: z.number(), courseName: z.string() }).optional(),
  course: z.looseObject({ courseId: z.number(), courseName: z.string(), items: list({ name: z.string() }) }).optional(),
  note: z.string().nullish(),
});
