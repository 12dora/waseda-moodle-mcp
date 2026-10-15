/**
 * Calendar feed content (§17.2): what is still to hand in (-7..+60 days) plus the timetable classes of the next
 * 28 days, rendered as one ICS document. The service calls are the console's (`getDueItems`, `getTimetableDays`);
 * everything below them is pure so the events can be tested without Moodle.
 */

import type { ServiceContext } from '../../core/context';
import { hash53 } from '../../core/hash';
import { getDueItems } from '../../core/services/due';
import { getTimetableDays } from '../../core/services/timetable';
import { addDays } from '../../core/services/timetable/calendar';
import { fmt, fmtDue, isoJst, toMs } from '../../core/time';
import type { DueItem, DueList, DueSubmission, TimetableClass, TimetableDay } from '../../core/types';
import { type IcsEvent, jstToMs, renderCalendar } from './ics';

const CALENDAR_NAME = 'Waseda Moodle';
const DUE_DAYS_BACK = 7;
const DUE_DAYS_AHEAD = 60;
const CLASS_DAYS = 28;
const FALLBACK_HOST = 'wasemoodle.invalid';
const MIDNIGHT_SHIFT_MS = 60_000; // a 00:00 deadline is placed at 23:59 of the day before

const SUBMISSION_LABEL: Partial<Record<DueSubmission['status'], string>> = {
  draft: 'draft saved, not submitted',
  'in-progress': 'attempt in progress, not submitted',
  reopened: 'reopened for resubmission',
};

const CLASS_SOURCE_NOTE: Record<TimetableClass['source'], string | null> = {
  syllabus: null,
  moodle: 'Time inferred from the Moodle attendance sessions.',
  user: 'Time set by you in the console.',
};

/** `<id>@host`, or `<id>-2@host`... when `used` already has it; the result is added to `used`. */
function uniqueUid(id: string, host: string, used: Set<string>): string {
  let uid = `${id}@${host}`;
  for (let n = 2; used.has(uid); n++) uid = `${id}-${n}@${host}`;
  used.add(uid);
  return uid;
}

/**
 * `wmm-due-<cmid>@host`; items without a cmid (and text mentions, which share their module's) use a hash of what
 * identifies them. The due date is part of it, so same-named weekly events stay apart whatever the list order.
 */
function dueUid(item: DueItem, host: string, used: Set<string>): string {
  const base =
    item.cmid !== null && item.source !== 'text'
      ? String(item.cmid)
      : hash53(`${item.courseId}|${item.name}|${item.dueAt}|${item.source}|${item.sourceUrl}`);
  return uniqueUid(`wmm-due-${base}`, host, used);
}

const submissionLabel = (item: DueItem): string | undefined =>
  item.submission ? SUBMISSION_LABEL[item.submission.status] : undefined;

function dueDescription(item: DueItem, dueAt: string): string {
  const lines = [`Course: ${item.courseName}`, `Type: ${item.kind}`, `Due: ${fmtDue(dueAt)} JST`];
  if (item.midnightDue) {
    lines.push(`Moodle's deadline is ${fmt(dueAt)} JST; it is shown at 23:59 of the previous day.`);
  }
  if (item.overdue) lines.push('Overdue.');
  const label = submissionLabel(item);
  if (label) lines.push(`Status: ${label}.`);
  if (item.submission?.note) lines.push(item.submission.note);
  if (item.source === 'text') {
    lines.push('Tentative: the date was found in course text, not in the Moodle calendar.');
    if (item.evidence) lines.push(`Text: ${item.evidence}`);
    if (item.sourceUrl) lines.push(`Found at: ${item.sourceUrl}`);
  }
  return lines.join('\n');
}

/** An outstanding item with a deadline: submitted and closed ones are left out, drafts and attempts are flagged. */
function dueEvent(item: DueItem, host: string, used: Set<string>): IcsEvent | null {
  if (item.dueAt === null || item.closed || item.submission?.status === 'submitted') return null;
  const label = submissionLabel(item);
  const at = toMs(item.dueAt);
  return {
    uid: dueUid(item, host, used),
    start: item.midnightDue ? at - MIDNIGHT_SHIFT_MS : at,
    summary: `Due: ${item.name} (${item.courseName})${label ? ` [${label}]` : ''}`,
    description: dueDescription(item, item.dueAt),
    url: item.url || undefined,
    tentative: item.source === 'text',
    free: true,
  };
}

function classEvent(date: string, c: TimetableClass, uid: string): IcsEvent {
  const sourceNote = CLASS_SOURCE_NOTE[c.source];
  const description = [`${c.periods} (${c.start}-${c.end} JST)`, ...(sourceNote ? [sourceNote] : [])].join('\n');
  return {
    uid,
    start: jstToMs(date, c.start),
    end: jstToMs(date, c.end),
    summary: c.courseName,
    description,
    location: [c.classroom, c.campus].filter(Boolean).join(', ') || undefined,
    url: c.url || undefined,
  };
}

export interface FeedData {
  due: Pick<DueList, 'items'>;
  /** The timetable days, in date order. */
  days: readonly TimetableDay[];
}

/**
 * `wmm-class-<courseId>-<date>-<from>-<to>[-n]@host`: the whole slot (periods and day/night clock) is the identity,
 * and a slot listed twice yields one event.
 */
function classEvents(days: readonly TimetableDay[], host: string, used: Set<string>): IcsEvent[] {
  const slots = new Set<string>();
  return days.flatMap((day) =>
    day.classes.flatMap((c) => {
      const slot = `${c.courseId}-${day.date}-${c.periodFrom}-${c.periodTo}${c.night ? '-n' : ''}`;
      if (slots.has(slot)) return [];
      slots.add(slot);
      return [classEvent(day.date, c, uniqueUid(`wmm-class-${slot}`, host, used))];
    }),
  );
}

/** The ICS document for already loaded data. `now` stamps the events (DTSTAMP). */
export function renderFeed(data: FeedData, opts: { host: string; now: number }): string {
  const used = new Set<string>();
  const due = data.due.items.flatMap((item) => dueEvent(item, opts.host, used) ?? []);
  const classes = classEvents(data.days, opts.host, used);
  return renderCalendar({ name: CALENDAR_NAME, stamp: opts.now, events: [...due, ...classes] });
}

function hostOf(publicUrl: string): string {
  try {
    return new URL(publicUrl).host || FALLBACK_HOST;
  } catch {
    return FALLBACK_HOST;
  }
}

/**
 * Loads the user's data through the service layer (their stored Moodle credential) and renders the feed. The content
 * sweep reads the stored course snapshots only (the cron keeps them fresh), so a feed poll never refreshes courses.
 */
export async function buildFeed(ctx: ServiceContext, now: number): Promise<string> {
  const due = await getDueItems(ctx, { daysAhead: DUE_DAYS_AHEAD, overdueDays: DUE_DAYS_BACK, sweep: 'cached' });
  const today = isoJst(now).slice(0, 10);
  const days = await getTimetableDays(
    ctx,
    Array.from({ length: CLASS_DAYS }, (_, i) => addDays(today, i)),
  );
  return renderFeed({ due, days }, { host: hostOf(ctx.publicUrl), now });
}

/**
 * What a calendar app shows while the Moodle credential is missing or rejected: one all-day event today that tells
 * the user to reconnect, pointing at the console (`publicUrl`, may be empty).
 */
export function reconnectFeed(opts: { publicUrl: string; now: number }): string {
  const today = isoJst(opts.now).slice(0, 10);
  const where = opts.publicUrl ? `Open ${opts.publicUrl}` : 'Open the console';
  const description = `The Moodle connection has expired, so this calendar is not updated. ${where} and connect again.`;
  return renderCalendar({
    name: CALENDAR_NAME,
    stamp: opts.now,
    events: [
      {
        uid: `wmm-reconnect@${hostOf(opts.publicUrl)}`,
        start: jstToMs(today, '00:00'),
        allDay: true,
        summary: 'Waseda Moodle: reconnect your account',
        description,
        url: opts.publicUrl || undefined,
        free: true,
      },
    ],
  });
}
