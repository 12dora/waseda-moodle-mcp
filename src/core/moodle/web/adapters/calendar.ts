/**
 * core_calendar_get_calendar_events on the web channel: the ajax `core_calendar_get_calendar_monthly_view` for every
 * month (Asia/Tokyo) of the window, all issued in one tick (one request), at most 13 months from `timestart`.
 * Month views list the events of all the user's courses (courseid 1 = site; one requested course → that course
 * only); a multi-day event shows on every day it spans, so events are de-duplicated by id. The answer keeps the
 * web-service filter semantics: requested courses, user/site events only when asked, events overlapping the window.
 */

import { queryInt } from '../html';
import type { WebFunctions, WebSession } from '../types';

const SITE_ID = 1;
const MAX_MONTHS = 13;
const JST_OFFSET_SEC = 9 * 3600;
const DEFAULT_SPAN_SEC = 31 * 86_400;
/** Modules whose real instance id is kept (see the r14 instance contract); others get the cmid from the event URL. */
const REAL_INSTANCE = new Set(['forum', 'hsuforum']);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const int = (v: unknown): number | null => {
  const n = Number(v);
  return v !== null && v !== '' && Number.isSafeInteger(n) ? n : null;
};

interface Month {
  year: number;
  month: number;
}

/** Calendar months (JST) from `from` through `to`, at most MAX_MONTHS. */
function monthsOf(from: number, to: number): Month[] {
  const start = new Date((from + JST_OFFSET_SEC) * 1000);
  const end = new Date((to + JST_OFFSET_SEC) * 1000);
  const out: Month[] = [];
  let index = start.getUTCFullYear() * 12 + start.getUTCMonth();
  const last = end.getUTCFullYear() * 12 + end.getUTCMonth();
  while (index <= last && out.length < MAX_MONTHS) {
    out.push({ year: Math.floor(index / 12), month: (index % 12) + 1 });
    index++;
  }
  return out;
}

interface Query {
  courseIds: Set<number>;
  timestart: number;
  timeend: number;
  userevents: boolean;
  siteevents: boolean;
}

const flag = (v: unknown) => v === undefined || v === true || Number(v) === 1;

function readQuery(params: Rec): Query {
  const events = isRec(params.events) ? params.events : {};
  const options = isRec(params.options) ? params.options : {};
  const ids = Array.isArray(events.courseids) ? events.courseids.map(Number) : [];
  const timestart = int(options.timestart) ?? Math.floor(Date.now() / 1000);
  const end = int(options.timeend);
  return {
    courseIds: new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0)),
    timestart,
    timeend: end && end > timestart ? end : timestart + DEFAULT_SPAN_SEC,
    userevents: flag(options.userevents),
    siteevents: flag(options.siteevents),
  };
}

const courseOf = (ev: Rec): number => int(ev.courseid) ?? (isRec(ev.course) ? (int(ev.course.id) ?? 0) : 0);

/** Moodle's window rule: starts inside it, or started before and is still running at its start. */
function inWindow(ev: Rec, q: Query): boolean {
  const start = int(ev.timestart) ?? 0;
  const duration = int(ev.timeduration) ?? 0;
  if (start >= q.timestart) return start <= q.timeend;
  return start + duration > q.timestart;
}

function wanted(ev: Rec, q: Query): boolean {
  if (ev.eventtype === 'user') return q.userevents;
  if (ev.eventtype === 'site') return q.siteevents;
  return q.courseIds.size === 0 || q.courseIds.has(courseOf(ev));
}

function toEvent(ev: Rec) {
  const modulename = typeof ev.modulename === 'string' ? ev.modulename : '';
  const url = typeof ev.url === 'string' ? ev.url : '';
  const cmid = modulename && url.includes('/mod/') ? queryInt(url, 'id') : null;
  const instance = REAL_INSTANCE.has(modulename) || cmid === null ? int(ev.instance) : cmid;
  return {
    id: int(ev.id),
    name: typeof ev.name === 'string' ? ev.name : '',
    description: typeof ev.description === 'string' ? ev.description : '',
    courseid: courseOf(ev),
    groupid: int(ev.groupid) ?? 0,
    userid: int(ev.userid) ?? 0,
    modulename,
    instance,
    eventtype: typeof ev.eventtype === 'string' ? ev.eventtype : '',
    timestart: int(ev.timestart) ?? 0,
    timeduration: int(ev.timeduration) ?? 0,
    ...(url ? { url } : {}),
  };
}

function eventsOfMonth(view: unknown): Rec[] {
  if (!isRec(view)) return [];
  return list(view.weeks).flatMap((week) => list(week.days).flatMap((day) => list(day.events)));
}

async function calendarEvents(web: WebSession, params: Rec) {
  const q = readQuery(params);
  const courseid = q.courseIds.size === 1 ? ([...q.courseIds][0] ?? SITE_ID) : SITE_ID;
  // issued in the same tick: one ajax request for every month
  const views = await Promise.all(
    monthsOf(q.timestart, q.timeend).map(({ year, month }) =>
      web.ajax<unknown>('core_calendar_get_calendar_monthly_view', {
        year,
        month,
        courseid,
        day: 1,
        includenavigation: false,
      }),
    ),
  );
  const seen = new Set<number>();
  const events = views.flatMap(eventsOfMonth).flatMap((ev) => {
    const id = int(ev.id);
    if (id === null || seen.has(id) || !wanted(ev, q) || !inWindow(ev, q)) return [];
    seen.add(id);
    return [toEvent(ev)];
  });
  return { events, warnings: [] };
}

export const calendarFunctions: WebFunctions = {
  core_calendar_get_calendar_events: (web, params) => calendarEvents(web, params),
};
