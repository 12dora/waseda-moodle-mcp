import * as z from 'zod';
import { list } from './common';

/** list_calendar_events */
export const calendarEventsOut = z.looseObject({
  from: z.string(),
  to: z.string(),
  includesCourseEvents: z.boolean(),
  events: list({ id: z.number(), name: z.string(), start: z.string() }),
});
