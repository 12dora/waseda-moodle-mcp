/**
 * The user's Moodle calendar events. The upcoming list is core_calendar_get_calendar_events (native on ws; on web
 * emulated from the month views, one ajax request for up to 4 months); one event by id is
 * core_calendar_get_calendar_event_by_id. Personal events have eventtype 'user' and are visible to their owner only.
 */

import type { MoodleApi, ServiceContext } from '../context';
import { MoodleError, NotFound, withOwnStep } from '../errors';
import { htmlToText } from '../html';
import { isoJst, nowSec } from '../time';
import type { IsoJst } from '../types';

type Raw = Record<string, unknown>;

const isRec = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(isRec) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => {
  const n = Number(v);
  return v !== null && v !== '' && typeof v !== 'boolean' && Number.isSafeInteger(n) ? n : null;
};
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const DAY_SEC = 86_400;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const MAX_DESCRIPTION_CHARS = 500;
/** Moodle's eventtype of a personal event. */
export const PERSONAL = 'user';

export interface CalendarEvent {
  id: number;
  name: string;
  /** Moodle's eventtype: 'user' (personal), 'course', 'group', 'category', 'site', or an activity's ('due', 'open', …). */
  eventType: string;
  /** A personal event: only the user sees it, and only these can be changed with prepare_calendar_event. */
  personal: boolean;
  start: IsoJst;
  /** null: the event has no duration. */
  end: IsoJst | null;
  courseId: number | null;
  /** The activity type of an activity event ('assign', 'quiz', …), null for others. */
  module: string | null;
  /** Plain text, cut to 500 characters. */
  description: string;
  url: string | null;
}

export interface CalendarEventList {
  from: IsoJst;
  to: IsoJst;
  includesCourseEvents: boolean;
  events: CalendarEvent[];
}

interface ListCalendarEventsInput {
  daysAhead?: number;
  includeCourseEvents?: boolean;
}

function toCalendarEvent(ev: Raw): CalendarEvent[] {
  const id = int(ev.id);
  const start = int(ev.timestart);
  if (id === null || !start) return [];
  const duration = int(ev.timeduration) ?? 0;
  const eventType = str(ev.eventtype) ?? '';
  const courseId = int(ev.courseid) ?? 0;
  return [
    {
      id,
      name: htmlToText(str(ev.name)) || `event ${id}`,
      eventType,
      personal: eventType === PERSONAL,
      start: isoJst(start * 1000),
      end: duration > 0 ? isoJst((start + duration) * 1000) : null,
      courseId: courseId > 0 ? courseId : null,
      module: str(ev.modulename),
      description: htmlToText(str(ev.description)).slice(0, MAX_DESCRIPTION_CHARS),
      url: str(ev.url),
    },
  ];
}

/** Upcoming events from now: personal ones only, or (includeCourseEvents) every event the user can see. One call. */
export async function listCalendarEvents(
  ctx: ServiceContext,
  input: ListCalendarEventsInput = {},
): Promise<CalendarEventList> {
  const days = Math.min(Math.max(Math.trunc(input.daysAhead ?? DEFAULT_DAYS), 1), MAX_DAYS);
  const include = input.includeCourseEvents === true;
  const from = nowSec();
  const to = from + days * DAY_SEC;
  const api = await ctx.moodle();
  // courseids [] = every course of the user (the web emulation and the web service agree on that)
  const res = await api.call<unknown>('core_calendar_get_calendar_events', {
    events: { courseids: [] },
    options: { userevents: 1, siteevents: include ? 1 : 0, timestart: from, timeend: to },
  });
  const events = list(isRec(res) ? res.events : null)
    .filter((ev) => include || ev.eventtype === PERSONAL)
    .flatMap(toCalendarEvent)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id - b.id);
  return { from: isoJst(from * 1000), to: isoJst(to * 1000), includesCourseEvents: include, events };
}

// ------------------------------------------------------------------ one event (write previews)

/** What the write actions need to know about one stored event. */
export interface StoredEvent {
  id: number;
  name: string;
  eventType: string;
  userId: number | null;
  timestart: number;
  timeduration: number;
  /** As Moodle exports it (formatted HTML). */
  descriptionHtml: string;
  location: string;
  /** Moodle's own verdicts; null when the answer lacks them. */
  canEdit: boolean | null;
  canDelete: boolean | null;
  /** Set when the event is one occurrence of a repeated series. */
  repeatId: number | null;
}

const MISSING_CODES = new Set(['invalidrecord', 'invalidrecordunknown', 'invalidparameter', 'nopermissions']);

const notFound = (eventId: number) =>
  withOwnStep(
    new NotFound(`Calendar event ${eventId} was not found (or you cannot see it). Use list_calendar_events for ids.`),
  );

function toStoredEvent(ev: Raw, eventId: number): StoredEvent {
  const repeatId = int(ev.repeatid) ?? 0;
  return {
    id: eventId,
    name: htmlToText(str(ev.name)) || `event ${eventId}`,
    eventType: str(ev.eventtype) ?? '',
    userId: int(ev.userid),
    timestart: int(ev.timestart) ?? 0,
    timeduration: int(ev.timeduration) ?? 0,
    descriptionHtml: str(ev.description) ?? '',
    location: str(ev.location) ?? '',
    canEdit: flag(ev.canedit),
    canDelete: flag(ev.candelete),
    repeatId: repeatId > 0 ? repeatId : null,
  };
}

export async function readCalendarEvent(api: MoodleApi, eventId: number): Promise<StoredEvent> {
  let res: unknown;
  try {
    res = await api.call<unknown>('core_calendar_get_calendar_event_by_id', { eventid: eventId });
  } catch (e) {
    if (e instanceof MoodleError && MISSING_CODES.has(e.errorcode)) throw notFound(eventId);
    throw e;
  }
  const ev = isRec(res) && isRec(res.event) ? res.event : null;
  if (!ev || int(ev.id) !== eventId) throw notFound(eventId);
  return toStoredEvent(ev, eventId);
}
