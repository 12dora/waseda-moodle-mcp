import { describe, expect, it } from 'vitest';
import { calendarFunctions } from '../../../../src/core/moodle/web/adapters/calendar';
import type { WebSession } from '../../../../src/core/moodle/web/types';
import { makeFakeWebSession } from '../../../helpers/fake-web-session';

/** Unix seconds of a Tokyo wall-clock time. */
const jst = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - 9, mi) / 1000;

type Ev = Record<string, unknown>;

const course = (id: number) => ({ id, fullname: `Course ${id}` });

/** Invented events, by the month (JST) they show in; a multi-day event shows in two months. */
const ATTEND: Ev = {
  id: 1,
  name: '総合日本語３Ｘ 出席',
  courseid: 99101,
  course: course(99101),
  eventtype: 'attendance',
  modulename: 'attendance',
  instance: 55,
  url: 'https://wsdmoodle.waseda.jp/mod/attendance/view.php?id=7201',
  timestart: jst(2026, 10, 2, 9, 0),
  timeduration: 6000,
};
const SPANNING: Ev = {
  id: 2,
  name: 'Field trip',
  courseid: 99101,
  eventtype: 'course',
  modulename: '',
  timestart: jst(2026, 10, 31, 9, 0),
  timeduration: 2 * 86_400,
};
const OTHER_COURSE: Ev = { id: 3, name: 'x', courseid: 99999, eventtype: 'course', timestart: jst(2026, 10, 5, 9, 0) };
const USER: Ev = { id: 4, name: 'my note', courseid: 0, eventtype: 'user', timestart: jst(2026, 10, 6, 9, 0) };
const SITE: Ev = { id: 5, name: 'maintenance', courseid: 1, eventtype: 'site', timestart: jst(2026, 10, 7, 9, 0) };
const BEFORE: Ev = { id: 6, name: 'early', courseid: 99101, eventtype: 'course', timestart: jst(2026, 9, 1, 9, 0) };
const NESTED_COURSE: Ev = {
  id: 7,
  name: 'Example Course meeting',
  course: course(99102),
  eventtype: 'attendance',
  modulename: 'attendance',
  instance: 56,
  url: 'https://wsdmoodle.waseda.jp/mod/attendance/view.php?id=8201',
  timestart: jst(2026, 11, 6, 13, 10),
  timeduration: 6000,
};
const FORUM: Ev = {
  id: 8,
  name: 'Forum due',
  courseid: 99101,
  eventtype: 'due',
  modulename: 'forum',
  instance: 4501,
  url: 'https://wsdmoodle.waseda.jp/mod/forum/view.php?id=7001',
  timestart: jst(2026, 10, 20, 23, 59),
  timeduration: 0,
};

const BY_MONTH: Record<string, Ev[]> = {
  '2026-9': [BEFORE],
  '2026-10': [ATTEND, SPANNING, OTHER_COURSE, USER, SITE, FORUM],
  '2026-11': [SPANNING, NESTED_COURSE],
};

/** A month view: weeks[].days[].events[] (one day per event is enough for the adapter). */
const monthView = (events: Ev[]) => ({
  weeks: [{ prepadding: [], days: events.map((e, i) => ({ mday: i + 1, events: [e] })) }, { days: [] }],
});

function session() {
  const asked: Record<string, unknown>[] = [];
  let answered = false;
  let late = 0;
  const base = makeFakeWebSession();
  const web: WebSession = {
    ...base,
    async ajax<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      expect(fn).toBe('core_calendar_get_calendar_monthly_view');
      if (answered) late++;
      asked.push(args);
      await new Promise((r) => setTimeout(r, 0));
      answered = true;
      return monthView(BY_MONTH[`${args.year}-${args.month}`] ?? []) as T;
    },
  };
  return { web, asked, late: () => late };
}

const events = async (web: WebSession, params: Record<string, unknown>) => {
  const impl = calendarFunctions.core_calendar_get_calendar_events;
  if (!impl) throw new Error('not emulated');
  return ((await impl(web, params, {})) as { events: Ev[] }).events;
};

describe('core_calendar_get_calendar_events', () => {
  it('asks every month of the window in one tick and filters like the web service', async () => {
    const { web, asked, late } = session();
    const list = await events(web, {
      events: { courseids: [99101, 99102] },
      options: { userevents: 0, siteevents: 0, timestart: jst(2026, 9, 15, 0, 0), timeend: jst(2026, 11, 10, 0, 0) },
    });
    expect(asked.map((a) => [a.year, a.month, a.courseid])).toEqual([
      [2026, 9, 1],
      [2026, 10, 1],
      [2026, 11, 1],
    ]);
    expect(late()).toBe(0);
    expect(list.map((e) => e.id)).toEqual([1, 2, 8, 7]);
    expect(list[0]).toEqual({
      id: 1,
      name: '総合日本語３Ｘ 出席',
      description: '',
      courseid: 99101,
      groupid: 0,
      userid: 0,
      modulename: 'attendance',
      instance: 7201,
      eventtype: 'attendance',
      timestart: jst(2026, 10, 2, 9, 0),
      timeduration: 6000,
      url: 'https://wsdmoodle.waseda.jp/mod/attendance/view.php?id=7201',
    });
    expect(list.find((e) => e.id === 8)?.instance).toBe(4501);
    expect(list.find((e) => e.id === 7)?.courseid).toBe(99102);
  });

  it('includes user and site events when asked; one course asks that course', async () => {
    const { web, asked } = session();
    const list = await events(web, {
      events: { courseids: [99101] },
      options: { userevents: 1, siteevents: 1, timestart: jst(2026, 10, 1, 0, 0), timeend: jst(2026, 10, 31, 0, 0) },
    });
    expect(asked.map((a) => a.courseid)).toEqual([99101]);
    expect(list.map((e) => e.id)).toEqual([1, 4, 5, 8]);
  });

  it('caps the window at 13 months', async () => {
    const { web, asked } = session();
    await events(web, {
      events: { courseids: [99101, 99102] },
      options: { timestart: jst(2026, 4, 1, 0, 0), timeend: jst(2028, 3, 31, 0, 0) },
    });
    expect(asked).toHaveLength(13);
    expect(asked.at(-1)).toMatchObject({ year: 2027, month: 4 });
  });

  it('a JST month boundary: 1 April 00:30 JST belongs to April', async () => {
    const { web, asked } = session();
    await events(web, {
      events: { courseids: [] },
      options: { timestart: jst(2027, 4, 1, 0, 30), timeend: jst(2027, 4, 2, 0, 0) },
    });
    expect(asked.map((a) => [a.year, a.month])).toEqual([[2027, 4]]);
  });
});
