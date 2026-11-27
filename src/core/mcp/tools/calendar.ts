import * as z from 'zod';
import { prepareCalendarEvent } from '../../services/actions';
import { listCalendarEvents } from '../../services/calendar';
import { renderActionPreview } from '../render/actions';
import { renderCalendarEvents } from '../render/calendar';
import { actionPreviewOut } from '../schemas/actions';
import { calendarEventsOut } from '../schemas/calendar';
import { defineTool, id, PREPARE_HINTS, READ_HINTS } from './define';

const isoTime = (describe: string) => z.string().min(1).max(40).describe(describe);

const listCalendarEventsTool = defineTool({
  name: 'list_calendar_events',
  title: 'Calendar events',
  description:
    "Lists the user's upcoming Moodle calendar events from now on, each with its event_id. By default only personal events " +
    '(their own, visible only to them); include_course_events adds course, site and activity events (deadlines, openings, ' +
    'attendance sessions). For what is due, prefer get_due_items. Create, edit or delete personal events with prepare_calendar_event.',
  annotations: READ_HINTS,
  input: z.object({
    days_ahead: z.number().int().min(1).max(90).describe('Days from now to include. Default 30.').optional(),
    include_course_events: z
      .boolean()
      .describe('Also list course, site and activity events, not only personal ones. Default false.')
      .optional(),
  }),
  output: calendarEventsOut,
  async run(ctx, a) {
    const r = await listCalendarEvents(ctx, { daysAhead: a.days_ahead, includeCourseEvents: a.include_course_events });
    return { text: renderCalendarEvents(r), data: r };
  },
});

const prepareCalendarEventTool = defineTool({
  name: 'prepare_calendar_event',
  title: 'Prepare calendar event change',
  description:
    'Step 1 of 2: prepares creating (action "create"), editing ("edit") or deleting ("delete") one of the user\'s PERSONAL ' +
    'Moodle calendar events (visible only to them) and returns a PREVIEW; nothing changes yet. Times are JST, ISO like ' +
    '2026-12-01T10:00. create needs name and start; edit changes only the fields given and keeps the rest (event_id from ' +
    'list_calendar_events). Course, site and activity events cannot be changed. ' +
    'Show the preview to the user and call confirm_action only after they agree.',
  annotations: PREPARE_HINTS,
  input: z.object({
    action: z.enum(['create', 'edit', 'delete']).describe('create a new personal event, edit or delete one.'),
    event_id: id('Personal event id from list_calendar_events (edit and delete).').optional(),
    name: z.string().max(255).describe('Event name (required for create).').optional(),
    start: isoTime('Start, ISO date-time in JST such as 2026-12-01T10:00 (required for create).').optional(),
    end: isoTime(
      'End, ISO date-time in JST, after start. Give end or duration_minutes; neither = no end time.',
    ).optional(),
    duration_minutes: z
      .number()
      .int()
      .min(0)
      .max(366 * 24 * 60)
      .describe('Length in minutes, instead of end (0 = no end time).')
      .optional(),
    description: z.string().max(10_000).describe('Plain-text description; on edit "" clears it.').optional(),
  }),
  output: actionPreviewOut,
  async run(ctx, a) {
    const r = await prepareCalendarEvent(ctx, {
      action: a.action,
      eventId: a.event_id,
      name: a.name,
      start: a.start,
      end: a.end,
      durationMinutes: a.duration_minutes,
      description: a.description,
    });
    return { text: renderActionPreview(r), data: r };
  },
});

export const calendarReadTools = [listCalendarEventsTool];
export const calendarWriteTools = [prepareCalendarEventTool];
