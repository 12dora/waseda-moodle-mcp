import * as z from 'zod';
import { getTimetable } from '../../services/timetable';
import { renderTimetable } from '../render/timetable';
import { defineTool, READ_HINTS } from './define';

const getTimetableTool = defineTool({
  name: 'get_timetable',
  title: 'Timetable',
  description:
    "Lists the user's classes per day with real start/end times, room and campus, from the public syllabus and the Waseda academic calendar " +
    '(term windows, holidays that are class days, no-class days). ' +
    'Use it for "what class do I have today / tomorrow / this week" and "when does X start". ' +
    'On-demand courses and courses without a known schedule are listed separately. Covers the confirmed courses only.',
  annotations: READ_HINTS,
  input: z.object({
    date: z
      .string()
      .regex(/^(today|tomorrow|\d{4}-\d{2}-\d{2})$/)
      .describe("First day: 'today' (default), 'tomorrow' or YYYY-MM-DD.")
      .optional(),
    days: z.number().int().min(1).max(14).describe('How many days from `date`. Default 1, max 14.').optional(),
  }),
  async run(ctx, a) {
    const r = await getTimetable(ctx, { date: a.date, days: a.days });
    return { text: renderTimetable(r), data: r };
  },
});

export const timetableTools = [getTimetableTool];
