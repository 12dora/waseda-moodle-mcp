/**
 * Moodle's calendar event form (core_calendar\local\event\forms\create, \update for an existing event), sent as a
 * browser would through core_calendar_submit_create_update_form {formdata}: the date selectors carry JST wall-clock
 * parts (the form reads them in the user's Moodle time zone; the executor reports a shifted start). The answer
 * carries the saved `event`, or `validationerror` when the form refused the values.
 */

import type { MoodleApi } from '../../context';
import { InvalidInput, MoodleError } from '../../errors';
import { randomDraftItemId } from '../../moodle/wire';
import { jstParts } from '../../time';
import { isRec, type Raw, str } from './shared';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;
const FORMAT_HTML = '1';
const JST_ZONE = '+09:00';

/** Minutes east of UTC of an ISO zone ('Z', '+09:00'). */
function zoneMinutes(zone: string): number {
  if (zone === 'Z') return 0;
  const sign = zone.startsWith('-') ? -1 : 1;
  return sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
}

/**
 * An ISO date-time as unix seconds, to the minute (the form has no seconds): JST when it carries no offset. Refuses
 * dates that do not exist (2026-02-30) instead of letting them roll over.
 */
export function parseEventTime(value: string, label: string): number {
  const m = ISO_RE.exec(value.trim());
  const [, y = '', mo = '', d = '', h = '', mi = ''] = m ?? [];
  const zone = m?.[7] ?? JST_ZONE;
  const ms = m ? Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00${zone}`) : Number.NaN;
  const wall = new Date(ms + zoneMinutes(zone) * 60_000);
  const exists =
    Number.isFinite(ms) &&
    wall.getUTCFullYear() === Number(y) &&
    wall.getUTCMonth() + 1 === Number(mo) &&
    wall.getUTCDate() === Number(d) &&
    wall.getUTCHours() === Number(h);
  if (!exists) throw new InvalidInput(`${label} must be an ISO date and time such as 2026-12-01T10:00 (JST).`);
  return ms / 1000;
}

/** What one saved event holds. `eventId` 0 = a new event; `timeend` === `timestart` = no duration. */
export type EventFields = {
  eventId: number;
  name: string;
  timestart: number;
  timeend: number;
  descriptionHtml: string;
  location: string;
};

function appendDate(form: URLSearchParams, field: string, sec: number): void {
  const p = jstParts(sec * 1000);
  form.append(`${field}[day]`, String(p.d));
  form.append(`${field}[month]`, String(p.mo));
  form.append(`${field}[year]`, String(p.y));
  form.append(`${field}[hour]`, String(p.h));
  form.append(`${field}[minute]`, String(p.mi));
}

interface FormContext {
  userId: number;
  /** The web session's sesskey; null on ws (the token authenticates the call). */
  sesskey: string | null;
  itemId: number;
}

/** The urlencoded form Moodle's own calendar dialog posts for a personal event. */
function eventFormData(f: EventFields, c: FormContext): string {
  const form = new URLSearchParams();
  form.append('id', String(f.eventId));
  form.append('userid', String(c.userId));
  form.append('modulename', '');
  form.append('instance', '0');
  form.append('visible', '1');
  if (c.sesskey) form.append('sesskey', c.sesskey);
  form.append(`_qf__core_calendar_local_event_forms_${f.eventId ? 'update' : 'create'}`, '1');
  form.append('mform_isexpanded_id_general', '1');
  form.append('name', f.name);
  appendDate(form, 'timestart', f.timestart);
  form.append('eventtype', 'user');
  form.append('description[text]', f.descriptionHtml);
  form.append('description[format]', FORMAT_HTML);
  form.append('description[itemid]', String(c.itemId));
  form.append('location', f.location);
  const hasEnd = f.timeend > f.timestart;
  form.append('duration', hasEnd ? '1' : '0');
  if (hasEnd) appendDate(form, 'timedurationuntil', f.timeend);
  form.append('repeat', '0');
  return form.toString();
}

const REFUSED = 'Moodle did not accept the event: check the name and that the end is after the start.';

/** Saves the event through Moodle's form; answers the saved event as Moodle exports it. */
export async function submitEventForm(api: MoodleApi, f: EventFields): Promise<Raw> {
  const sesskey = api.web ? await api.web.sesskey() : null;
  // a fresh draft area: the description keeps no embedded files (personal events made here have none)
  const formdata = eventFormData(f, { userId: api.moodleUserId, sesskey, itemId: randomDraftItemId() });
  const res = await api.call<unknown>('core_calendar_submit_create_update_form', { formdata });
  const event = isRec(res) && isRec(res.event) ? res.event : null;
  if (event && !(isRec(res) && res.validationerror === true)) return event;
  const said = isRec(res) ? str(res.validationerror) : null;
  throw new MoodleError(said ?? REFUSED, 'validation');
}
