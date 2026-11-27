import type { CalendarEvent, CalendarEventList } from '../../services/calendar';
import { fmt, fmtDue } from '../../time';
import { assemble, oneLine, plural } from './common';

/** Personal events show their own time; activity events (due, close, …) read 00:00 as the previous day 24:00. */
function eventLine(e: CalendarEvent): string {
  const show = e.personal ? fmt : fmtDue;
  const time = e.end ? `${show(e.start)} – ${show(e.end)}` : show(e.start);
  const kind = e.personal ? 'personal' : [e.eventType, e.module].filter(Boolean).join(' ') || 'event';
  const course = e.courseId ? ` · course_id ${e.courseId}` : '';
  const description = e.description ? `\n  ${oneLine(e.description, 160)}` : '';
  return `- ${time} · ${oneLine(e.name, 120)} (${kind}, event_id ${e.id})${course}${description}`;
}

const NONE_PERSONAL = 'No personal events in this period. Pass include_course_events for course and activity events.';

export function renderCalendarEvents(r: CalendarEventList): string {
  const scope = r.includesCourseEvents ? 'Calendar events' : 'Personal calendar events';
  const head = [`${scope} ${fmt(r.from)} – ${fmt(r.to)} JST: ${plural(r.events.length, 'event')}`];
  if (r.events.length === 0) head.push(r.includesCourseEvents ? 'Nothing in this period.' : NONE_PERSONAL);
  return assemble({
    head,
    entries: r.events.map((e) => ({ text: eventLine(e), item: true })),
    footer: ['', 'Create, edit or delete a personal event with prepare_calendar_event (event_id).'],
    hint: 'pass a smaller days_ahead',
  });
}
