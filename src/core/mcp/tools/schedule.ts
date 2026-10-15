import * as z from 'zod';
import { setScheduleOverride } from '../../services/schedule-overrides';
import { resolveScope } from '../../services/scope';
import type { Course, ScheduleOverride } from '../../types';
import { courseScheduleOut } from '../schemas/schedule';
import { defineTool, id, LOCAL_SETTING_HINTS } from './define';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const periods = z.number().int().min(1).max(7);

const input = z.object({
  course_id: id('A course_id from list_courses.'),
  mode: z
    .enum(['slots', 'on-demand', 'none', 'auto'])
    .describe(
      "'slots' = weekly meetings at the given times; 'on-demand' = no meeting time (on-demand only); " +
        "'none' = no weekly class (hide it from the timetable); 'auto' = remove the saved times and use the syllabus / Moodle again.",
    ),
  slots: z
    .array(
      z.object({
        weekday: z.number().int().min(1).max(7).describe('1 = Monday ... 7 = Sunday.'),
        period_from: periods.describe('First period (時限) of the meeting, 1-7.'),
        period_to: periods.describe('Last period of the meeting, 1-7 (same as period_from for a single period).'),
        classroom: z.string().max(40).describe('Room, e.g. "22-909".').optional(),
        night: z
          .boolean()
          .describe('WBS 夜間主 weekday evening classes (Mon-Fri, periods 6-7 only). Default false.')
          .optional(),
      }),
    )
    .max(6)
    .describe("Required for mode 'slots': the weekly meetings (1 to 6).")
    .optional(),
  also_on_demand: z
    .boolean()
    .describe("Only with mode 'slots': the course also has on-demand work besides its meetings. Default false.")
    .optional(),
});

type Input = z.output<typeof input>;

/** `null` = 'auto'. A 'slots' call without slots fails the service's own validation. */
function overrideOf(a: Input): ScheduleOverride | null {
  if (a.mode === 'auto') return null;
  const slots = (a.slots ?? []).map((s) => ({
    weekday: s.weekday,
    periodFrom: s.period_from,
    periodTo: s.period_to,
    night: s.night ?? false,
    classroom: s.classroom ?? null,
  }));
  const slotMode = a.mode === 'slots';
  return { mode: a.mode, slots: slotMode ? slots : [], alsoOnDemand: slotMode && (a.also_on_demand ?? false) };
}

const periodsLabel = (from: number, to: number) => (from === to ? `P${from}` : `P${from}–${to}`);

function describeOverride(o: ScheduleOverride): string {
  if (o.mode === 'on-demand') return 'on-demand, no meeting time';
  if (o.mode === 'none') return 'no weekly class (hidden from the timetable)';
  const slots = o.slots
    .map((s) => {
      const room = s.classroom ? ` (${s.classroom})` : '';
      return `${WEEKDAYS[s.weekday - 1]} ${periodsLabel(s.periodFrom, s.periodTo)}${s.night ? ' evening' : ''}${room}`;
    })
    .join(', ');
  return o.alsoOnDemand ? `${slots}; also on-demand` : slots;
}

/** The timetable lists the user's own class courses only: say so when a saved time will not show. */
function visibility(course: Course | undefined): string {
  if (!course || (course.mine && course.kind === 'class')) return '';
  if (course.kind !== 'class') return ' Not a class course, so it will not show in the timetable.';
  return ' Not in your courses — add it with set_my_courses to see it in the timetable.';
}

const setCourseScheduleTool = defineTool({
  name: 'set_course_schedule',
  title: 'Set course schedule',
  description:
    "Saves the weekday, periods and room of a course's weekly class in the user's timetable, or marks it on-demand / not a weekly class. " +
    'Use it only after the user states the time (e.g. "総合日本語３Ｘ is Friday periods 1-2 in 22-909"), typically for a course that get_timetable lists without a time; never guess. ' +
    "Mode 'auto' removes the saved times again. This only changes the times kept by this server, nothing in Moodle.",
  annotations: LOCAL_SETTING_HINTS,
  input,
  output: courseScheduleOut,
  async run(ctx, a) {
    const override = await setScheduleOverride(ctx, a.course_id, overrideOf(a));
    const course = (await resolveScope(ctx)).courses.find((c) => c.id === a.course_id);
    const name = course?.name ?? `course ${a.course_id}`;
    const saved = override[String(a.course_id)];
    const text = saved
      ? `Saved: ${name} — ${describeOverride(saved)}.${visibility(course)}`
      : `Cleared: ${name} — automatic times again.`;
    return { text, data: { courseId: a.course_id, schedule: saved ?? null } };
  },
});

export const scheduleTools = [setCourseScheduleTool];
