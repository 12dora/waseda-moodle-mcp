/**
 * Picks the class-time source of each course in scope (contract §15.1): the user's own times, else the public
 * syllabus, else the attendance sessions seen in Moodle. Courses with nothing (sure) to show end up in `unknown` with
 * the reason, so the user can be told what to do about it.
 */

import type { ServiceContext } from '../../context';
import { nowMs } from '../../time';
import type { Course, TimetableUnknown } from '../../types';
import { lookupSeenCourses, type SyllabusInfo } from '../syllabus';
import {
  hasPartialSchedule,
  hasUsableSchedule,
  inferredEntry,
  overrideEntry,
  syllabusEntry,
  type TimetableEntry,
} from './entries';
import { type Inference, inferSchedules } from './moodle-slots';

interface ResolvedCourses {
  entries: TimetableEntry[];
  unknown: TimetableUnknown[];
}

/** A course gives an entry, an unknown, or both (a partly understood syllabus: what is known, flagged as unsure). */
interface Outcome {
  entry: TimetableEntry | null;
  unknown: TimetableUnknown | null;
}

/** A course whose syllabus gave nothing (sure) to show: it may still be found in Moodle. */
interface Unresolved {
  course: Course;
  info: SyllabusInfo | null;
}

const entryOnly = (entry: TimetableEntry): Outcome => ({ entry, unknown: null });

const toSec = (iso: string | null) => (iso === null ? null : Math.floor(Date.parse(iso) / 1000));

/**
 * Why nothing sure is known. A syllabus whose time was not (fully) understood says so; without a syllabus: the lookup
 * switched off, Moodle checked and found no weekly meeting (`not-found`), or nothing could be asked yet (`pending`).
 */
function missingReason(ctx: ServiceContext, c: Unresolved, checked: boolean): TimetableUnknown['reason'] {
  if (c.info?.scheduleUnparsed) return 'unparsed';
  if (ctx.syllabusLookup === false) return 'lookup-off';
  return checked ? 'not-found' : 'pending';
}

/** What is left for a course after the syllabus and Moodle both had their say. */
function fallbackOutcome(ctx: ServiceContext, c: Unresolved, inference: Inference): Outcome {
  const { course, info } = c;
  const inferred = inference.found.get(course.id);
  const fromMoodle = inferred ? inferredEntry(course, inferred, nowMs()) : null;
  if (fromMoodle) return entryOnly(fromMoodle);
  // a syllabus that says "no meeting" (無その他) is a course without fixed time, not an unknown one
  const understood = info !== null && !info.scheduleUnparsed;
  const entry = info && (understood || hasPartialSchedule(info)) ? syllabusEntry(course, info) : null;
  if (understood) return { entry, unknown: null };
  const reason = missingReason(ctx, c, inference.checked.has(course.id));
  return { entry, unknown: { courseId: course.id, courseName: course.name, url: course.url, reason } };
}

async function inferFor(ctx: ServiceContext, list: Unresolved[]): Promise<Inference> {
  if (list.length === 0) return { found: new Map(), checked: new Set() };
  return inferSchedules(
    ctx,
    list.map(({ course }) => ({ id: course.id, start: toSec(course.start), end: toSec(course.end) })),
  );
}

/**
 * One entry and/or one unknown per course, in the order given; courses the user set to `none` are left out. User times
 * first, then the syllabus; what it cannot place completely goes to ONE Moodle attendance lookup. Uses the cached
 * syllabus; uncached courses are fetched within the request's syllabus budget.
 */
export async function resolveCourses(ctx: ServiceContext, courses: Course[]): Promise<ResolvedCourses> {
  const overrides = ctx.user.settings.scheduleOverrides ?? {};
  const infos = await lookupSeenCourses(
    ctx,
    courses.map((c) => c.id),
  );
  const outcomes = new Map<number, Outcome>();
  const unresolved: Unresolved[] = [];
  for (const course of courses) {
    const info = infos.get(course.id) ?? null;
    const override = overrides[String(course.id)];
    if (override !== undefined) outcomes.set(course.id, entryOnly(overrideEntry(course, override, info)));
    else if (info && hasUsableSchedule(info)) outcomes.set(course.id, entryOnly(syllabusEntry(course, info)));
    else unresolved.push({ course, info });
  }
  const inference = await inferFor(ctx, unresolved);
  for (const c of unresolved) outcomes.set(c.course.id, fallbackOutcome(ctx, c, inference));
  const out: ResolvedCourses = { entries: [], unknown: [] };
  for (const course of courses) {
    const outcome = outcomes.get(course.id);
    if (outcome?.entry) out.entries.push(outcome.entry);
    if (outcome?.unknown) out.unknown.push(outcome.unknown);
  }
  return out;
}
