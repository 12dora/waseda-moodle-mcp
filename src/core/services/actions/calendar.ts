/**
 * Personal Moodle calendar events (eventtype 'user', visible to the user only): create, edit, delete. Edit and
 * delete read the event first (core_calendar_get_calendar_event_by_id) and refuse every other event type (course,
 * group, category, site and activity events) and events of other users. Create and edit go through Moodle's own
 * event form (calendar-form.ts; ws create: core_calendar_create_calendar_events; edit is web-session only, the token
 * service has no update function); delete is core_calendar_delete_calendar_events. Edit and delete change one
 * occurrence of a repeated series, never the series.
 */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput } from '../../errors';
import { htmlToText } from '../../html';
import { settleChannel } from '../../moodle/web/channel';
import { fmt, isoJst, nowSec } from '../../time';
import type { ActionPreview } from '../../types';
import { webSessionOf } from '../activity/web';
import { PERSONAL, readCalendarEvent, type StoredEvent } from '../calendar';
import { calendarUrl, type EventFields, parseEventTime, submitEventForm } from './calendar-form';
import {
  type ActionOutcome,
  assertWriteAllowed,
  isRec,
  num,
  positiveInt,
  previewText,
  type Raw,
  refusal,
  requireText,
  savePreview,
} from './shared';
import { plainTextToHtml } from './text';

interface PrepareCalendarEventInput {
  action: 'create' | 'edit' | 'delete';
  eventId?: number;
  name?: string;
  /** ISO date-time, JST unless it carries an offset. */
  start?: string;
  end?: string;
  durationMinutes?: number;
  /** Plain text; '' clears it on edit. */
  description?: string;
}

type SavePayload = EventFields & { url: string };
type DeletePayload = { eventId: number; name: string; url: string };

const MAX_NAME_CHARS = 255;
const MAX_DESCRIPTION_CHARS = 10_000;
const MAX_DURATION_MINUTES = 366 * 24 * 60;

const dayUrl = (api: MoodleApi, sec: number) => `${api.baseUrl}/calendar/view.php?view=day&time=${sec}`;

const when = (f: Pick<EventFields, 'timestart' | 'timeend'>) => {
  const start = fmt(isoJst(f.timestart * 1000));
  return f.timeend > f.timestart ? `${start} – ${fmt(isoJst(f.timeend * 1000))} JST` : `${start} JST (no end time)`;
};

function eventLines(f: EventFields): string[] {
  const text = htmlToText(f.descriptionHtml);
  return [`Name: ${f.name}`, `When: ${when(f)}`, ...(text ? [`Description: ${previewText(text)}`] : [])];
}

// ------------------------------------------------------------------ input

interface Timing {
  timestart: number;
  timeend: number;
}

function durationEnd(minutes: number, timestart: number): number {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_DURATION_MINUTES) {
    throw new InvalidInput(`duration_minutes must be a whole number from 0 to ${MAX_DURATION_MINUTES}.`);
  }
  return timestart + minutes * 60;
}

/** The new end: `end`, or `duration_minutes`, or (edit) the event's current length from the new start. */
function endOf(input: PrepareCalendarEventInput, timestart: number, base: Timing | null): number {
  if (input.end !== undefined && input.durationMinutes !== undefined) {
    throw new InvalidInput('Give end or duration_minutes, not both.');
  }
  if (input.durationMinutes !== undefined) return durationEnd(input.durationMinutes, timestart);
  if (input.end === undefined) return timestart + (base ? base.timeend - base.timestart : 0);
  const end = parseEventTime(input.end, 'end');
  if (end <= timestart) throw new InvalidInput('end must be after start.');
  return end;
}

function timingOf(input: PrepareCalendarEventInput, base: Timing | null): Timing {
  const timestart = input.start === undefined ? base?.timestart : parseEventTime(input.start, 'start');
  if (timestart === undefined) throw new InvalidInput('start is required to create an event.');
  return { timestart, timeend: endOf(input, timestart, base) };
}

function descriptionOf(input: PrepareCalendarEventInput, current: string): string {
  if (input.description === undefined) return current;
  if (input.description.length > MAX_DESCRIPTION_CHARS) {
    throw new InvalidInput(`The description is too long (max ${MAX_DESCRIPTION_CHARS} characters).`);
  }
  return plainTextToHtml(input.description);
}

const pastWarning = (t: Timing): string[] => (t.timestart < nowSec() ? ['The start time is in the past.'] : []);

/** One occurrence of a repeated series: the action leaves the other occurrences as they are. */
const seriesWarning = (ev: StoredEvent, done: 'changed' | 'deleted'): string[] =>
  ev.repeatId ? [`This event is one of a repeated series; only this occurrence is ${done}.`] : [];

// ------------------------------------------------------------------ prepare

async function prepareCreate(ctx: ServiceContext, api: MoodleApi, input: PrepareCalendarEventInput) {
  const name = requireText(input.name, 'event name', MAX_NAME_CHARS);
  const timing = timingOf(input, null);
  const descriptionHtml = descriptionOf(input, '');
  const fields: EventFields = { eventId: 0, name, ...timing, descriptionHtml, location: '' };
  const payload: SavePayload = { ...fields, url: dayUrl(api, timing.timestart) };
  return savePreview(ctx, {
    kind: 'calendar_event_create',
    title: `Create calendar event '${name}'`,
    details: [...eventLines(fields), 'Type: personal event (only you can see it)'],
    warnings: pastWarning(timing),
    payload,
  });
}

const CHANGES = 'Give at least one of name, start, end, duration_minutes or description to change.';

async function prepareEdit(ctx: ServiceContext, api: MoodleApi, ev: StoredEvent, input: PrepareCalendarEventInput) {
  const { name: newName, start, end, durationMinutes, description } = input;
  if ([newName, start, end, durationMinutes, description].every((v) => v === undefined)) {
    throw new InvalidInput(CHANGES);
  }
  const current: EventFields = {
    eventId: ev.id,
    name: ev.name,
    timestart: ev.timestart,
    timeend: ev.timestart + ev.timeduration,
    descriptionHtml: ev.descriptionHtml,
    location: ev.location,
  };
  const name = newName === undefined ? ev.name : requireText(newName, 'event name', MAX_NAME_CHARS);
  const timing = timingOf(input, current);
  const descriptionHtml = descriptionOf(input, ev.descriptionHtml);
  const fields: EventFields = { ...current, name, ...timing, descriptionHtml };
  const same = JSON.stringify(fields) === JSON.stringify(current);
  const payload: SavePayload = { ...fields, url: dayUrl(api, timing.timestart) };
  return savePreview(ctx, {
    kind: 'calendar_event_edit',
    title: `Edit calendar event '${ev.name}'`,
    details: [`Now: ${ev.name} · ${when(current)}`, 'After the change:', ...eventLines(fields)],
    warnings: [
      ...pastWarning(timing),
      ...seriesWarning(ev, 'changed'),
      ...(same ? ['Nothing changes: the event already has these values.'] : []),
    ],
    payload,
  });
}

async function prepareDelete(ctx: ServiceContext, api: MoodleApi, ev: StoredEvent) {
  const payload: DeletePayload = { eventId: ev.id, name: ev.name, url: calendarUrl(api) };
  const timing = { timestart: ev.timestart, timeend: ev.timestart + ev.timeduration };
  return savePreview(ctx, {
    kind: 'calendar_event_delete',
    title: `Delete calendar event '${ev.name}'`,
    details: [`Name: ${ev.name}`, `When: ${when(timing)}`],
    warnings: ['Deleting cannot be undone.', ...seriesWarning(ev, 'deleted')],
    payload,
  });
}

/** The event, when it is one of the user's own personal events that Moodle lets them change this way. */
async function personalEvent(api: MoodleApi, eventId: number, action: 'edit' | 'delete'): Promise<StoredEvent> {
  const ev = await readCalendarEvent(api, eventId);
  if (ev.eventType !== PERSONAL || ev.userId !== api.moodleUserId) {
    const type = ev.eventType || 'unknown';
    throw new InvalidInput(
      `Event ${eventId} is a ${type} event, not one of your personal events; only personal events can be changed here.`,
    );
  }
  if ((action === 'edit' ? ev.canEdit : ev.canDelete) === false) {
    throw new InvalidInput(`Moodle does not let you ${action} this event.`);
  }
  return ev;
}

export async function prepareCalendarEvent(
  ctx: ServiceContext,
  input: PrepareCalendarEventInput,
): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  const { action } = input;
  if (action !== 'create' && action !== 'edit' && action !== 'delete') {
    throw new InvalidInput('action must be create, edit or delete.');
  }
  const api = await ctx.moodle();
  await settleChannel(api);
  if (action === 'create') return prepareCreate(ctx, api, input);
  // the event form is ajax-only and needs the session's sesskey (calendar-form.ts guards the executor the same way)
  if (action === 'edit') webSessionOf(api, calendarUrl(api));
  const ev = await personalEvent(api, positiveInt(input.eventId, 'event_id'), action);
  return action === 'edit' ? prepareEdit(ctx, api, ev, input) : prepareDelete(ctx, api, ev);
}

// ------------------------------------------------------------------ execute

/** The outcome of a saved event; notes a start Moodle stored differently (a Moodle profile time zone other than JST). */
function savedOutcome(verb: string, p: SavePayload, saved: Raw): ActionOutcome {
  const id = num(saved.id) ?? p.eventId;
  const stored = num(saved.timestart);
  const shifted =
    stored !== null && stored !== p.timestart
      ? ` Moodle stored the start as ${fmt(isoJst(stored * 1000))} JST; check the time zone in your Moodle profile.`
      : '';
  return { message: `${verb} calendar event '${p.name}' (event_id ${id}).${shifted}`, url: p.url };
}

/** ws: the web service creates events directly (the token channel has no form sesskey). */
async function createViaWs(api: MoodleApi, p: SavePayload): Promise<Raw> {
  const res = await api.call<unknown>('core_calendar_create_calendar_events', {
    events: [
      {
        name: p.name,
        description: p.descriptionHtml,
        format: 1,
        courseid: 0,
        groupid: 0,
        repeats: 0,
        eventtype: PERSONAL,
        timestart: p.timestart,
        timeduration: p.timeend - p.timestart,
        visible: 1,
      },
    ],
  });
  const [event] = isRec(res) && Array.isArray(res.events) ? res.events.filter(isRec) : [];
  if (!event) throw refusal('did not create the event', res);
  return event;
}

export async function executeCalendarEventCreate(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as SavePayload;
  const saved = api.web ? await submitEventForm(api, p) : await createViaWs(api, p);
  return savedOutcome('Created', p, saved);
}

export async function executeCalendarEventEdit(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as SavePayload;
  return savedOutcome('Updated', p, await submitEventForm(api, p));
}

export async function executeCalendarEventDelete(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as DeletePayload;
  await api.call<unknown>('core_calendar_delete_calendar_events', {
    events: [{ eventid: p.eventId, repeat: 0 }],
  });
  return { message: `Deleted calendar event '${p.name}'.`, url: p.url };
}
