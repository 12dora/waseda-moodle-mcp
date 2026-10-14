import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError } from '../../src/core/errors';
import type { RawActionEvent } from '../../src/core/services/due';
import { dueKind, getDueItems, mergeDueEvents, parseCmid } from '../../src/core/services/due';
import { collectSweepItems } from '../../src/core/services/sweep';
import type { DueItem } from '../../src/core/types';
import eventsFixture from '../fixtures/be2/action_events.json';
import timeline from '../fixtures/be2/timeline_courses.json';
import { makeFakeContext } from '../helpers/fake-context';

vi.mock('../../src/core/services/sweep', () => ({ collectSweepItems: vi.fn() }));

const TIMELINE = 'core_course_get_enrolled_courses_by_timeline_classification';
const ENROL = 'core_enrol_get_users_courses';
const NO_STATS = { checked: 0, stale: 0, checkedAt: null };
/** A sweep that finds nothing and hands the calendar list back untouched. */
const NO_SWEEP: typeof collectSweepItems = async (_ctx, _scope, calendar) => ({
  items: [],
  calendar: [...calendar],
  stats: NO_STATS,
});

const GLOBAL = 'core_calendar_get_action_events_by_timesort';
const BY_COURSE = 'core_calendar_get_action_events_by_course';
const NOW = new Date('2026-10-14T03:00:00Z'); // 2026-10-14 12:00 JST
const NOW_SEC = 1791946800;
const DAY = 86_400;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.mocked(collectSweepItems).mockReset().mockImplementation(NO_SWEEP);
});
afterEach(() => {
  vi.useRealTimers();
});

const ALL_NAMES = [
  'Report 0',
  'Report 1',
  'Elective Essay',
  'Quiz A',
  'Discussion Post',
  'Case Memo',
  'Survey 1',
  'Quiz B',
  'External Tool',
];

function event(id: number, inst: number, extra: Partial<RawActionEvent> = {}): RawActionEvent {
  return {
    id,
    name: `Item ${inst} is due`,
    activityname: `Item ${inst}`,
    eventtype: 'due',
    modulename: 'assign',
    instance: inst,
    timesort: NOW_SEC + inst * 60,
    course: { id: 101, fullname: 'Course &amp; Co' },
    url: `https://moodle.example.edu/mod/assign/view.php?id=${inst}`,
    action: { name: 'Add submission' },
    ...extra,
  };
}

/** A paged feed: page n returns `sizes[n]` events with consecutive ids; lastid mirrors Moodle. */
function pagedFeed(sizes: number[]) {
  return (_params: Record<string, unknown>, callIndex: number) => {
    const size = sizes[callIndex] ?? 0;
    const start = sizes.slice(0, callIndex).reduce((a, b) => a + b, 0);
    const events = Array.from({ length: size }, (_, i) => event(1000 + start + i, 1 + start + i));
    return { events, firstid: events[0]?.id ?? 0, lastid: events[events.length - 1]?.id ?? 0 };
  };
}

describe('mergeDueEvents', () => {
  const items = mergeDueEvents(eventsFixture.events, NOW_SEC);
  const byName = (n: string) => items.find((i) => i.name === n);

  it('merges open/close per activity and sorts chronologically', () => {
    expect(items.map((i) => i.name)).toEqual(ALL_NAMES);
  });

  it('maps an assignment with a passed deadline', () => {
    expect(byName('Report 0')).toEqual({
      kind: 'assign',
      courseId: 101,
      courseName: 'Introduction to Finance & Accounting',
      cmid: 5005,
      name: 'Report 0',
      opensAt: null,
      dueAt: '2026-10-12T23:59:00+09:00',
      midnightDue: false,
      overdue: true,
      closed: false,
      notOpenYet: false,
      url: 'https://moodle.example.edu/mod/assign/view.php?id=5005',
      action: 'Add submission',
      source: 'calendar',
      evidence: null,
      sourceUrl: null,
      isNew: false,
    });
  });

  it('combines the open and close events of a quiz', () => {
    expect(byName('Quiz A')).toMatchObject({
      kind: 'quiz',
      cmid: 5002,
      opensAt: '2026-10-14T09:00:00+09:00',
      dueAt: '2026-10-16T17:00:00+09:00',
      overdue: false,
      notOpenYet: false,
      action: 'Attempt quiz now',
    });
    expect(byName('Quiz B')).toMatchObject({ opensAt: '2026-10-20T10:00:00+09:00', notOpenYet: true });
    expect(byName('Survey 1')).toMatchObject({
      kind: 'questionnaire',
      opensAt: '2026-10-13T09:00:00+09:00',
      dueAt: '2026-10-19T23:59:00+09:00',
    });
  });

  it('flags midnight deadlines and maps module kinds', () => {
    expect(byName('Case Memo')).toMatchObject({ midnightDue: true, dueAt: '2026-10-18T00:00:00+09:00' });
    expect(byName('Report 1')?.midnightDue).toBe(false);
    expect(byName('Discussion Post')?.kind).toBe('forum');
    expect(byName('External Tool')?.kind).toBe('other');
  });

  it('keeps open-only activities (dueAt null) and sorts them by their opening time', () => {
    const open = event(1, 1, { eventtype: 'open', modulename: 'quiz', timesort: NOW_SEC + DAY });
    const due = event(2, 2, { timesort: NOW_SEC + 2 * DAY });
    const merged = mergeDueEvents([due, open], NOW_SEC);
    expect(merged.map((i) => i.name)).toEqual(['Item 1', 'Item 2']);
    expect(merged[0]).toMatchObject({
      dueAt: null,
      opensAt: '2026-10-15T12:00:00+09:00',
      overdue: false,
      notOpenYet: true,
    });
  });

  it('does not merge different modules that share an instance id', () => {
    const merged = mergeDueEvents(
      [event(1, 5, { modulename: 'assign' }), event(2, 5, { modulename: 'quiz', eventtype: 'close' })],
      NOW_SEC,
    );
    expect(merged.map((i) => i.kind).sort()).toEqual(['assign', 'quiz']);
  });

  it('falls back to the event name, decodes entities and uses the instance as cmid for non-module urls', () => {
    const [item] = mergeDueEvents(
      [
        event(1, 1, {
          activityname: undefined,
          name: 'Reading &amp; Notes',
          url: 'https://moodle.example.edu/calendar/view.php?id=9',
          action: null,
        }),
      ],
      NOW_SEC,
    );
    expect(item).toMatchObject({ name: 'Reading & Notes', cmid: 1, action: null, courseName: 'Course & Co' });
    const calendarOnly = event(2, 2, { modulename: undefined, url: 'https://moodle.example.edu/calendar/view.php' });
    const [plain] = mergeDueEvents([calendarOnly], NOW_SEC);
    expect(plain).toMatchObject({ kind: 'other', cmid: null });
  });

  it('marks overdue items that Moodle no longer accepts as closed', () => {
    const past = NOW_SEC - DAY;
    const [closed, open, upcoming] = mergeDueEvents(
      [
        event(1, 1, { timesort: past, action: { name: 'Add submission', actionable: false } }),
        event(2, 2, { timesort: past + 1, action: { name: 'Add submission', actionable: true } }),
        event(3, 3, { timesort: NOW_SEC + DAY, action: { name: 'Add submission', actionable: false } }),
      ],
      NOW_SEC,
    );
    expect([closed, open, upcoming].map((i) => [i?.overdue, i?.closed])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
  });

  it('uses other event types as the deadline only when no due/close event exists', () => {
    const merged = mergeDueEvents(
      [
        event(1, 1, { eventtype: 'expectcompletionon', timesort: NOW_SEC + DAY }),
        event(2, 2, { eventtype: 'gradingdue', timesort: NOW_SEC + DAY }),
        event(3, 2, { eventtype: 'due', timesort: NOW_SEC + 5 * DAY }),
      ],
      NOW_SEC,
    );
    expect(merged.find((i) => i.name === 'Item 1')?.dueAt).toBe('2026-10-15T12:00:00+09:00');
    expect(merged.find((i) => i.name === 'Item 2')?.dueAt).toBe('2026-10-19T12:00:00+09:00');
  });

  it('parseCmid and dueKind', () => {
    expect(parseCmid('https://x.example/mod/quiz/view.php?id=77&foo=1')).toBe(77);
    expect(parseCmid(undefined, 'https://x.example/mod/assign/view.php?a=1&id=8')).toBe(8);
    expect(parseCmid('https://x.example/calendar/view.php?id=77')).toBeNull();
    expect(dueKind('hsuforum')).toBe('forum');
    expect(dueKind('workshop')).toBe('workshop');
    expect(dueKind(undefined)).toBe('other');
  });
});

/** All four fixture courses attended recently -> the automatic scope covers every class course. */
const SCOPE_RESPONSES = {
  [TIMELINE]: timeline,
  [ENROL]: timeline.courses.map((c) => ({ id: c.id, lastaccess: NOW_SEC - DAY })),
};
const calls = (api: { calls: Array<{ fn: string }> }, fn: string) => api.calls.filter((c) => c.fn === fn);

describe('getDueItems', () => {
  it('queries the default window and returns the merged list with scope and sweep info', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [GLOBAL]: eventsFixture, ...SCOPE_RESPONSES } });
    const list = await getDueItems(ctx);
    expect(calls(api, GLOBAL)).toEqual([
      {
        fn: GLOBAL,
        params: {
          timesortfrom: NOW_SEC - 14 * DAY,
          timesortto: NOW_SEC + 14 * DAY,
          limitnum: 50,
          limittononsuspendedevents: 1,
        },
      },
    ]);
    expect(list).toMatchObject({
      generatedAt: '2026-10-14T12:00:00+09:00',
      windowFrom: '2026-09-30T12:00:00+09:00',
      windowTo: '2026-10-28T12:00:00+09:00',
      scope: { mode: 'auto', courseIds: [101, 102, 103, 104], otherCount: 0 },
      sweep: { checked: 0, stale: 0, checkedAt: null },
      truncated: false,
    });
    expect(list.items.map((i) => i.name)).toEqual(ALL_NAMES);
  });

  it('lists calendar items of courses outside the scope apart (never dropped); otherCount counts courses', async () => {
    const { ctx } = makeFakeContext({
      responses: { [GLOBAL]: eventsFixture, ...SCOPE_RESPONSES },
      user: { settings: { myCourseIds: [101, 102, 104] } },
    });
    const list = await getDueItems(ctx);
    expect(list.scope).toEqual({ mode: 'mine', courseIds: [101, 102, 104], otherCount: 1 });
    expect(list.items.map((i) => i.name)).toEqual(ALL_NAMES.filter((n) => n !== 'Elective Essay'));
    expect(list.otherCourses.map((i) => [i.name, i.courseId, i.source])).toEqual([['Elective Essay', 103, 'calendar']]);
  });

  it('has no other-course group when everything is in scope or one course is asked for', async () => {
    const all = makeFakeContext({ responses: { [GLOBAL]: eventsFixture, ...SCOPE_RESPONSES } });
    expect((await getDueItems(all.ctx)).otherCourses).toEqual([]);
    const one = makeFakeContext({
      responses: { [BY_COURSE]: eventsFixture, [GLOBAL]: eventsFixture, ...SCOPE_RESPONSES },
      user: { settings: { myCourseIds: [101] } },
    });
    const list = await getDueItems(one.ctx, { courseId: 103 });
    expect(list.otherCourses).toEqual([]);
    expect(list.items.map((i) => i.courseId)).toEqual([103]);
  });

  it('feeds the sweep with the in-scope calendar items and the window, and merges its items by date', async () => {
    const undated = { ...mergeDueEvents([event(1, 1)], NOW_SEC)[0], name: 'Undated task', dueAt: null, opensAt: null };
    const early = { ...undated, name: 'Mentioned', source: 'text', dueAt: '2026-10-01T09:00:00+09:00' };
    vi.mocked(collectSweepItems).mockImplementation(async (_c, _s, calendar) => ({
      items: [undated as DueItem, early as DueItem],
      calendar: [...calendar],
      stats: { checked: 2, stale: 1, checkedAt: '2026-10-14T11:50:00+09:00' },
    }));
    const { ctx } = makeFakeContext({
      responses: { [GLOBAL]: eventsFixture, ...SCOPE_RESPONSES },
      user: { settings: { myCourseIds: [101] } },
    });
    const list = await getDueItems(ctx);
    expect(list.sweep).toEqual({ checked: 2, stale: 1, checkedAt: '2026-10-14T11:50:00+09:00' });
    expect(list.items.map((i) => i.name)).toEqual(['Mentioned', 'Report 0', 'Report 1', 'Quiz A', 'Undated task']);

    const [sweepCtx, scope, calendar, window] = vi.mocked(collectSweepItems).mock.calls[0] ?? [];
    expect(sweepCtx).toBe(ctx);
    expect([...(scope?.mine ?? [])]).toEqual([101]);
    expect(calendar?.map((i) => i.name)).toEqual(['Report 0', 'Report 1', 'Quiz A']);
    expect(window).toEqual({ fromMs: (NOW_SEC - 14 * DAY) * 1000, toMs: (NOW_SEC + 14 * DAY) * 1000 });
  });

  it('lists the calendar items as the sweep returns them (a date found in module text is attached there)', async () => {
    vi.mocked(collectSweepItems).mockImplementation(async (_c, _s, calendar) => ({
      items: [],
      calendar: calendar.map((i) =>
        i.name === 'Quiz A' ? { ...i, dueAt: '2026-10-30T23:59:00+09:00', evidence: 'Deadline 30 October' } : i,
      ),
      stats: NO_STATS,
    }));
    const { ctx } = makeFakeContext({
      responses: { [GLOBAL]: eventsFixture, ...SCOPE_RESPONSES },
      user: { settings: { myCourseIds: [101] } },
    });
    const list = await getDueItems(ctx);
    expect(list.items.find((i) => i.name === 'Quiz A')).toMatchObject({
      dueAt: '2026-10-30T23:59:00+09:00',
      source: 'calendar',
      evidence: 'Deadline 30 October',
    });
    expect(list.items.at(-1)?.name).toBe('Quiz A');
  });

  it('uses a shared 30-day events call as the signal of the automatic suggestion; later events stay listed apart', async () => {
    const soon = event(1, 1, { course: { id: 102, fullname: 'Seminar' }, timesort: NOW_SEC + 20 * DAY });
    const later = event(2, 2, { course: { id: 104, fullname: 'Elective' }, timesort: NOW_SEC + 40 * DAY });
    const feed = (params: Record<string, unknown>) => ({
      events: [soon, later].filter((e) => (e.timesort ?? 0) <= Number(params.timesortto)),
    });
    const { ctx, api } = makeFakeContext({
      responses: { [GLOBAL]: feed, [TIMELINE]: timeline, [ENROL]: [{ id: 101, lastaccess: 0 }] },
    });
    const list = await getDueItems(ctx, { daysAhead: 120 });
    expect(list.scope.courseIds).toEqual([102]);
    expect(list.items.map((i) => i.courseId)).toEqual([102]);
    expect(list.otherCourses.map((i) => i.courseId)).toEqual([104]); // beyond the 30-day signal: still not lost
    expect(api.count(GLOBAL)).toBe(2); // the due window + the shared signal call
  });

  it('clamps the window (max 120 days ahead, 60 days back) and honours small values', async () => {
    const big = makeFakeContext({ responses: { [GLOBAL]: { events: [] }, ...SCOPE_RESPONSES } });
    await getDueItems(big.ctx, { daysAhead: 500, overdueDays: 100 });
    expect(big.api.calls[0]?.params).toMatchObject({
      timesortfrom: NOW_SEC - 60 * DAY,
      timesortto: NOW_SEC + 120 * DAY,
    });

    const small = makeFakeContext({ responses: { [GLOBAL]: { events: [] }, ...SCOPE_RESPONSES } });
    await getDueItems(small.ctx, { daysAhead: 3, overdueDays: 0 });
    expect(small.api.calls[0]?.params).toMatchObject({ timesortfrom: NOW_SEC, timesortto: NOW_SEC + 3 * DAY });
  });

  it('pages with aftereventid until a short page', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [GLOBAL]: pagedFeed([50, 50, 10]), ...SCOPE_RESPONSES } });
    const list = await getDueItems(ctx);
    expect(api.count(GLOBAL)).toBe(3);
    expect(
      calls(api, GLOBAL).map((c) => (c as unknown as { params: Record<string, unknown> }).params.aftereventid),
    ).toEqual([undefined, 1049, 1099]);
    expect(list.items).toHaveLength(110);
    expect(list.truncated).toBe(false);
  });

  it('stops after 4 pages and reports truncation', async () => {
    const { ctx, api } = makeFakeContext({
      responses: { [GLOBAL]: pagedFeed([50, 50, 50, 50, 50, 50]), ...SCOPE_RESPONSES },
    });
    const list = await getDueItems(ctx);
    expect(api.count(GLOBAL)).toBe(4);
    expect(list.items).toHaveLength(200);
    expect(list.truncated).toBe(true);
  });

  it('does not report truncation when the last full page is followed by an empty one', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [GLOBAL]: pagedFeed([50, 0]), ...SCOPE_RESPONSES } });
    const list = await getDueItems(ctx);
    expect(api.count(GLOBAL)).toBe(2);
    expect(list.truncated).toBe(false);
  });

  it('rejects an invalid course id', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [GLOBAL]: { events: [] } } });
    await expect(getDueItems(ctx, { courseId: 0 })).rejects.toBeInstanceOf(InvalidInput);
    expect(api.calls).toHaveLength(0);
  });

  it('uses the per-course feed for an explicit course, bypassing the scope (also for the sweep)', async () => {
    const { ctx, api } = makeFakeContext({
      responses: { [BY_COURSE]: eventsFixture, ...SCOPE_RESPONSES },
      user: { settings: { myCourseIds: [102] } },
    });
    const list = await getDueItems(ctx, { courseId: 101 });
    expect(calls(api, BY_COURSE)).toEqual([
      {
        fn: BY_COURSE,
        params: { courseid: 101, timesortfrom: NOW_SEC - 14 * DAY, timesortto: NOW_SEC + 14 * DAY, limitnum: 50 },
      },
    ]);
    expect(list.items.map((i) => i.name)).toEqual(['Report 0', 'Report 1', 'Quiz A']);
    expect(list.scope).toEqual({ mode: 'mine', courseIds: [102], otherCount: 3 });
    expect([...(vi.mocked(collectSweepItems).mock.calls[0]?.[1].mine ?? [])]).toEqual([101]);
  });

  it('falls back to the global feed (filtered) when the per-course function is unavailable', async () => {
    const { ctx, api } = makeFakeContext({
      responses: {
        [BY_COURSE]: new MoodleError('Access control exception', 'accessexception'),
        [GLOBAL]: eventsFixture,
        ...SCOPE_RESPONSES,
      },
    });
    const list = await getDueItems(ctx, { courseId: 101 });
    expect([BY_COURSE, GLOBAL].map((fn) => api.count(fn))).toEqual([1, 1]);
    expect(list.items.map((i) => i.name)).toEqual(['Report 0', 'Report 1', 'Quiz A']);
  });
});
