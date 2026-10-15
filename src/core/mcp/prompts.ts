import { completable, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { ServiceContext } from '../context';
import { completeCourseIds } from './completion';

const userPrompt = (lines: string[]) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text: lines.join('\n') } }],
});

/** A course id; the suggestions append the course name after the digits ("300907 — Finance"), which is ignored. */
const COURSE_ARG = /^\d+(?:\s.*)?$/;
/** A fresh schema per server: `completable` marks the schema object itself, once. */
const courseArg = () => z.string().regex(COURSE_ARG).describe('Course id from list_courses.');
const leadingDigits = (arg: string) => /^\d+/.exec(arg)?.[0] ?? arg;

/** Today: classes, assignments & deadlines, unread. Another day: its classes and the assignments around it. */
function briefingSteps(date: string | undefined): string[] {
  if (date) {
    return [
      `1. Call get_timetable with date=${date} for the classes of that day.`,
      '2. Call get_due_items with days_ahead=14 and overdue_days=14; keep what is overdue by that date or due within 3 days of it.',
    ];
  }
  return [
    '1. Call get_timetable with date=today for the classes of today.',
    '2. Call get_due_items with days_ahead=3 and overdue_days=14.',
    '3. Call list_notifications with unread_only=true and limit=10; if there are unread items, also call list_messages with unread_only=true and limit=5.',
  ];
}

function registerDailyBriefing(server: McpServer): void {
  server.registerPrompt(
    'daily_briefing',
    {
      title: 'Daily briefing',
      description:
        'Classes, overdue and upcoming assignments & deadlines, and unread notifications as a short plan for today (or for another date).',
      argsSchema: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('Day to plan, YYYY-MM-DD (JST). Default: today.')
          .optional(),
      }),
    },
    ({ date }) =>
      userPrompt([
        `Give me my Waseda Moodle briefing for ${date ?? 'today'}.`,
        ...briefingSteps(date),
        'Then write a concise plan: the classes, then anything overdue or due within 24 hours (exact JST time; a 00:00 deadline means the previous day 24:00), then what follows in the next 3 days, then unread items worth reading.',
        'Suggest an order of work for the day with rough effort. Do not submit, post or send anything.',
      ]),
  );
}

function registerWeeklyPlan(server: McpServer): void {
  server.registerPrompt(
    'weekly_plan',
    {
      title: 'Weekly plan',
      description:
        'Assignments and deadlines in the next 7 days grouped by day, with effort estimates and a suggested schedule.',
    },
    () =>
      userPrompt([
        'Plan my next 7 days of Waseda Moodle work.',
        '1. Call get_due_items with days_ahead=7 and overdue_days=7.',
        '2. For the larger assignments call get_activity to read the requirements before estimating effort.',
        'Then group the work by day (JST; a 00:00 deadline means the previous day 24:00), give a rough effort estimate for each item in hours, point out days that are overloaded, and propose when to work on what.',
        'Do not submit, post or send anything.',
      ]),
  );
}

function registerExamPrep(server: McpServer, ctx: ServiceContext): void {
  server.registerPrompt(
    'exam_prep',
    {
      title: 'Exam preparation',
      description:
        'Study plan for one course: grading and session plan from the syllabus, the course materials and the latest slides.',
      argsSchema: z.object({
        course_id: completable(courseArg(), (typed) => completeCourseIds(ctx, typed, true)),
      }),
    },
    ({ course_id: arg }) => {
      const courseId = leadingDigits(arg);
      return userPrompt([
        `Help me prepare for the exam of Waseda Moodle course ${courseId}.`,
        `1. Call get_syllabus with course_id=${courseId}; note how the course is graded (exam / report weights, criteria) and the session plan. If the digest cuts these off, call it again with focus=grading and focus=plan.`,
        `2. Call get_course with course_id=${courseId} to see the materials and activities by section.`,
        '3. Call get_file on the most recent lecture slides (newest PDF or slides in the outline) with inline=true when small, and read them.',
        'Then summarise: how the grade is made up, which sessions and topics are covered so far, what to study first, and a short study schedule up to the exam.',
        'Say clearly what comes from the syllabus (the teacher may change it) and what comes from the course files. Do not submit, post or send anything.',
      ]);
    },
  );
}

/** `ctx` serves the course-id completions of exam_prep (the user's own courses). */
export function registerPrompts(server: McpServer, ctx: ServiceContext): void {
  registerDailyBriefing(server);
  registerWeeklyPlan(server);
  registerExamPrep(server, ctx);
}
