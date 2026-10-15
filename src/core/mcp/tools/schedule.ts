import * as z from 'zod';
import type { ServiceContext } from '../../context';
import { setScheduleOverride } from '../../services/schedule-overrides';
import { resolveScope } from '../../services/scope';
import type { ScheduleOverride } from '../../types';
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
      }),
    )
    .min(1)
    .max(6)
    .describe("Required for mode 'slots': the weekly meetings (at most 6).")
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
    classroom: s.classroom ?? null,
  }));
  return { mode: a.mode, slots: a.mode === 'slots' ? slots : [] };
}

const periodsLabel = (from: number, to: number) => (from === to ? `P${from}` : `P${from}–${to}`);

function describeOverride(o: ScheduleOverride): string {
  if (o.mode === 'on-demand') return 'on-demand, no meeting time';
  if (o.mode === 'none') return 'no weekly class (hidden from the timetable)';
  return o.slots
    .map((s) => {
      const room = s.classroom ? ` (${s.classroom})` : '';
      return `${WEEKDAYS[s.weekday - 1]} ${periodsLabel(s.periodFrom, s.periodTo)}${room}`;
    })
    .join(', ');
}

async function courseName(ctx: ServiceContext, courseId: number): Promise<string> {
  const course = (await resolveScope(ctx)).courses.find((c) => c.id === courseId);
  return course?.name ?? `course ${courseId}`;
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
  async run(ctx, a) {
    const override = await setScheduleOverride(ctx, a.course_id, overrideOf(a));
    const name = await courseName(ctx, a.course_id);
    const saved = override[String(a.course_id)];
    const text = saved ? `Saved: ${name} — ${describeOverride(saved)}.` : `Cleared: ${name} — automatic times again.`;
    return { text, data: { courseId: a.course_id, schedule: saved ?? null } };
  },
});

export const scheduleTools = [setCourseScheduleTool];
