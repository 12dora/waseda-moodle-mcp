/** "What is due": calendar action events merged per activity into DueItems. */

import type { MoodleApi, ServiceContext } from '../context';
import { MoodleError } from '../errors';
import { decodeEntities } from '../html';
import { isMidnight, isoJst, nowSec, toMs } from '../time';
import type { DueItem, DueKind, DueList } from '../types';
import { resolveScope } from './scope';
import { collectSweepItems } from './sweep';
import { optionalPositiveInt } from './validate';

const GLOBAL_FN = 'core_calendar_get_action_events_by_timesort';
const BY_COURSE_FN = 'core_calendar_get_action_events_by_course';
const PAGE_SIZE = 50; // Moodle accepts 1..50
const MAX_PAGES = 4;
const DAY = 86_400;

export interface RawActionEvent {
  id?: number;
  name?: string;
  activityname?: string;
  eventtype?: string;
  modulename?: string;
  instance?: number;
  timesort?: number;
  timestart?: number;
  url?: string;
  course?: { id?: number; fullname?: string } | null;
  action?: { name?: string; url?: string; actionable?: boolean } | null;
}

interface RawEventsResponse {
  events?: RawActionEvent[];
  firstid?: number;
  lastid?: number;
}

const KIND_BY_MODULE: Record<string, DueKind> = {
  assign: 'assign',
  quiz: 'quiz',
  questionnaire: 'questionnaire',
  lesson: 'lesson',
  workshop: 'workshop',
  forum: 'forum',
  hsuforum: 'forum',
};

export function dueKind(modulename: string | null | undefined): DueKind {
  return (modulename && KIND_BY_MODULE[modulename]) || 'other';
}

/** cmid from `.../mod/<name>/view.php?id=<cmid>`; null for non-module URLs (calendar, course...). */
export function parseCmid(...urls: Array<string | null | undefined>): number | null {
  for (const u of urls) {
    if (!u?.includes('/mod/')) continue;
    const m = /[?&]id=(\d+)/.exec(u);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

/** On Waseda the event `instance` equals the cmid, so it backs up URLs that are not /mod/ links. */
function eventCmid(ev: RawActionEvent): number | null {
  return parseCmid(ev.url, ev.action?.url) ?? (ev.modulename && ev.instance ? ev.instance : null);
}

const eventTime = (ev: RawActionEvent) => ev.timesort || ev.timestart || 0;
const isDueType = (ev: RawActionEvent) => ev.eventtype === 'due' || ev.eventtype === 'close';
const isOpenType = (ev: RawActionEvent) => ev.eventtype === 'open';

function earliest(evs: RawActionEvent[]): RawActionEvent | undefined {
  let best: RawActionEvent | undefined;
  for (const ev of evs) if (!best || eventTime(ev) < eventTime(best)) best = ev;
  return best;
}

interface Row {
  sort: number;
  item: DueItem;
}

const iso = (ts: number | null) => (ts === null ? null : isoJst(ts * 1000));

function activityName(evs: RawActionEvent[]): string {
  return decodeEntities(evs.find((e) => e.activityname)?.activityname ?? evs.find((e) => e.name)?.name ?? '');
}

/** Event URL / action label: from the primary event, else the first event that has one. */
function eventUrl(primary: RawActionEvent, evs: RawActionEvent[]): string {
  return primary.url || primary.action?.url || evs.find((e) => e.url)?.url || '';
}

function actionLabel(primary: RawActionEvent, evs: RawActionEvent[]): string | null {
  return primary.action?.name || evs.find((e) => e.action?.name)?.action?.name || null;
}

/** One DueItem from all events of an activity: open -> opensAt, due/close -> dueAt (other types only as a fallback). */
function buildRow(evs: RawActionEvent[], now: number): Row | null {
  const opens = earliest(evs.filter(isOpenType));
  const due = earliest(evs.filter(isDueType));
  const deadline = due ?? earliest(evs.filter((e) => !isOpenType(e) && !isDueType(e)));
  const first = evs[0];
  if (!first || (!deadline && !opens)) return null;

  const primary = due ?? first;
  const dueTs = deadline ? eventTime(deadline) : null;
  const opensTs = opens ? eventTime(opens) : null;
  const overdue = dueTs !== null && dueTs < now;
  return {
    sort: dueTs ?? opensTs ?? 0,
    item: {
      kind: dueKind(first.modulename),
      courseId: Number(first.course?.id ?? 0),
      courseName: decodeEntities(first.course?.fullname ?? ''),
      cmid: evs.map(eventCmid).find((c) => c !== null) ?? null,
      name: activityName(evs),
      opensAt: iso(opensTs),
      dueAt: iso(dueTs),
      midnightDue: dueTs !== null && isMidnight(dueTs),
      overdue,
      closed: overdue && primary.action?.actionable === false,
      notOpenYet: opensTs !== null && opensTs > now,
      url: eventUrl(primary, evs),
      action: actionLabel(primary, evs),
      source: 'calendar',
      evidence: null,
      sourceUrl: null,
      isNew: false,
    },
  };
}

/**
 * Merges events per (modulename, instance); events without a module stay separate.
 * Sorted by (dueAt ?? opensAt) ascending. Pure: `now` is unix seconds.
 */
export function mergeDueEvents(events: RawActionEvent[], now: number): DueItem[] {
  const groups = new Map<string, RawActionEvent[]>();
  for (const ev of events) {
    if (!eventTime(ev)) continue;
    const key = ev.modulename && ev.instance ? `${ev.modulename}:${ev.instance}` : `event:${ev.id ?? groups.size}`;
    const group = groups.get(key);
    if (group) group.push(ev);
    else groups.set(key, [ev]);
  }
  const rows: Row[] = [];
  for (const evs of groups.values()) {
    const row = buildRow(evs, now);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => a.sort - b.sort || a.item.name.localeCompare(b.item.name));
  return rows.map((r) => r.item);
}

const clamp = (v: number | undefined, lo: number, hi: number, dflt: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(v) ? Math.trunc(v as number) : dflt));

type PageFetcher = (after: number) => Promise<RawEventsResponse>;

/** Per-course feed when asked for one course; if Moodle refuses it, the global feed (filtered by the caller). */
function pageFetcher(api: MoodleApi, win: { from: number; to: number }, courseId: number | undefined): PageFetcher {
  let byCourse = courseId !== undefined;
  const cursor = (after: number) => (after ? { aftereventid: after } : {});
  return async (after) => {
    if (byCourse) {
      try {
        return await api.call<RawEventsResponse>(BY_COURSE_FN, {
          courseid: courseId,
          timesortfrom: win.from,
          timesortto: win.to,
          limitnum: PAGE_SIZE,
          ...cursor(after),
        });
      } catch (e) {
        if (!(e instanceof MoodleError)) throw e;
        byCourse = false;
      }
    }
    return api.call<RawEventsResponse>(GLOBAL_FN, {
      timesortfrom: win.from,
      timesortto: win.to,
      limitnum: PAGE_SIZE,
      limittononsuspendedevents: 1,
      ...cursor(after),
    });
  };
}

/** Cursor for the next page, or null when this one was the last. */
function nextCursor(res: RawEventsResponse, batch: RawActionEvent[], after: number): number | null {
  if (batch.length < PAGE_SIZE) return null;
  const last = res.lastid ?? batch[batch.length - 1]?.id ?? 0;
  return last && last !== after ? last : null;
}

async function collectEvents(fetchPage: PageFetcher): Promise<{ events: RawActionEvent[]; truncated: boolean }> {
  const seen = new Set<number>();
  const events: RawActionEvent[] = [];
  let truncated = false;
  let after = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchPage(after);
    const batch = res?.events ?? [];
    for (const ev of batch) {
      if (ev.id !== undefined && seen.has(ev.id)) continue;
      if (ev.id !== undefined) seen.add(ev.id);
      events.push(ev);
    }
    const next = nextCursor(res, batch, after);
    if (next === null) break;
    after = next;
    truncated = page === MAX_PAGES - 1;
  }
  return { events, truncated };
}

/** (dueAt ?? opensAt) ascending; items without any date go last. Stable, so calendar order survives ties. */
function byDate(a: DueItem, b: DueItem): number {
  const key = (i: DueItem) => {
    const at = i.dueAt ?? i.opensAt;
    return at === null ? Number.POSITIVE_INFINITY : toMs(at);
  };
  const [ka, kb] = [key(a), key(b)];
  if (ka === kb) return 0;
  return ka < kb ? -1 : 1;
}

export async function getDueItems(
  ctx: ServiceContext,
  opts: { daysAhead?: number; overdueDays?: number; courseId?: number } = {},
): Promise<DueList> {
  const courseId = optionalPositiveInt(opts.courseId, 'course_id');
  const now = nowSec();
  const from = now - clamp(opts.overdueDays, 0, 60, 14) * DAY;
  const to = now + clamp(opts.daysAhead, 1, 120, 14) * DAY;
  const api = await ctx.moodle();

  const { events, truncated } = await collectEvents(pageFetcher(api, { from, to }, courseId));
  const scope = await resolveScope(ctx);
  const scoped = courseId === undefined ? events : events.filter((e) => e.course?.id === courseId);
  // the calendar is authoritative: items of courses outside the scope are listed apart, never dropped
  const merged = mergeDueEvents(scoped, now);
  const inScope = (i: DueItem) => courseId !== undefined || scope.mine.has(i.courseId);
  const calendar = merged.filter(inScope);
  const otherCourses = merged.filter((i) => !inScope(i));

  // an explicit course bypasses the scope, for the sweep too
  const sweepScope = courseId === undefined ? scope : { ...scope, mine: new Set([courseId]) };
  const sweep = await collectSweepItems(ctx, sweepScope, calendar, { fromMs: from * 1000, toMs: to * 1000 });

  return {
    generatedAt: isoJst(now * 1000),
    windowFrom: isoJst(from * 1000),
    windowTo: isoJst(to * 1000),
    items: [...sweep.calendar, ...sweep.items].sort(byDate), // sweep.calendar = calendar + dates found in module text
    scope: {
      mode: scope.mode,
      courseIds: [...scope.mine],
      otherCount: scope.courses.filter((c) => !scope.mine.has(c.id)).length,
    },
    otherCourses,
    sweep: sweep.stats,
    truncated,
  };
}
