/**
 * Picks the class-time source of each course in scope (contract §15.1): the user's own times, else the public
 * syllabus, else the attendance sessions seen in Moodle. Courses with nothing to show end up in `unknown` with the
 * reason, so the user can be told what to do about it.
 */

import type { ServiceContext } from '../../context';
import type { Course, InferredSchedule, TimetableUnknown } from '../../types';
import { lookupSeenCourses, type SyllabusInfo } from '../syllabus';
import { hasUsableSchedule, inferredEntry, overrideEntry, syllabusEntry, type TimetableEntry } from './entries';
import { inferSchedules } from './moodle-slots';

interface ResolvedCourses {
  entries: TimetableEntry[];
  unknown: TimetableUnknown[];
}

type Outcome = { entry: TimetableEntry } | { unknown: TimetableUnknown };

/** A course whose syllabus gave nothing to show: it may still be found in Moodle. */
interface Unresolved {
  course: Course;
  info: SyllabusInfo | null;
}

const toSec = (iso: string | null) => (iso === null ? null : Math.floor(Date.parse(iso) / 1000));

/**
 * Why nothing is known. A syllabus whose time was not understood says so; without a syllabus: the lookup switched
 * off, Moodle checked and found no weekly meeting (`not-found`), or nothing could be asked yet (`pending`).
 */
function missingReason(
  ctx: ServiceContext,
  c: Unresolved,
  inferred: InferredSchedule | undefined,
): TimetableUnknown['reason'] {
  if (c.info?.scheduleUnparsed) return 'unparsed';
  if (ctx.syllabusLookup === false) return 'lookup-off';
  return inferred ? 'not-found' : 'pending';
}

/** What is left for a course after the syllabus and Moodle both had their say. */
function fallbackOutcome(ctx: ServiceContext, c: Unresolved, inferred: InferredSchedule | undefined): Outcome {
  const fromMoodle = inferred ? inferredEntry(c.course, inferred) : null;
  if (fromMoodle) return { entry: fromMoodle };
  // a syllabus that says "no meeting" (無その他) is a course without fixed time, not an unknown one
  if (c.info && !c.info.scheduleUnparsed) return { entry: syllabusEntry(c.course, c.info) };
  const { course } = c;
  return {
    unknown: {
      courseId: course.id,
      courseName: course.name,
      url: course.url,
      reason: missingReason(ctx, c, inferred),
    },
  };
}

async function inferFor(ctx: ServiceContext, list: Unresolved[]): Promise<Map<number, InferredSchedule>> {
  if (list.length === 0) return new Map();
  return inferSchedules(
    ctx,
    list.map(({ course }) => ({ id: course.id, start: toSec(course.start), end: toSec(course.end) })),
  );
}

/** Syllabus first; what it cannot place goes to ONE Moodle attendance lookup. Fills `outcomes`. */
async function resolveOpen(ctx: ServiceContext, open: Course[], outcomes: Map<number, Outcome>): Promise<void> {
  const infos = await lookupSeenCourses(
    ctx,
    open.map((c) => c.id),
  );
  const unresolved: Unresolved[] = [];
  for (const course of open) {
    const info = infos.get(course.id) ?? null;
    if (info && hasUsableSchedule(info)) outcomes.set(course.id, { entry: syllabusEntry(course, info) });
    else unresolved.push({ course, info });
  }
  const inferred = await inferFor(ctx, unresolved);
  for (const c of unresolved) outcomes.set(c.course.id, fallbackOutcome(ctx, c, inferred.get(c.course.id)));
}

/**
 * One entry or one unknown per course, in the order given; courses the user set to `none` are left out. Uses the
 * cached syllabus; uncached courses are fetched within the request's syllabus budget.
 */
export async function resolveCourses(ctx: ServiceContext, courses: Course[]): Promise<ResolvedCourses> {
  const overrides = ctx.user.settings.scheduleOverrides ?? {};
  const outcomes = new Map<number, Outcome>();
  const open: Course[] = [];
  for (const course of courses) {
    const override = overrides[String(course.id)];
    if (override === undefined) open.push(course);
    else outcomes.set(course.id, { entry: overrideEntry(course, override) });
  }
  await resolveOpen(ctx, open, outcomes);
  const out: ResolvedCourses = { entries: [], unknown: [] };
  for (const course of courses) {
    const outcome = outcomes.get(course.id);
    if (outcome && 'entry' in outcome) out.entries.push(outcome.entry);
    else if (outcome) out.unknown.push(outcome.unknown);
  }
  return out;
}
