import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError } from '../../src/core/errors';
import type { RawActionEvent } from '../../src/core/services/due';
import { dueKind, getDueItems, mergeDueEvents, parseCmid } from '../../src/core/services/due';
import eventsFixture from '../fixtures/be2/action_events.json';
import { makeFakeContext } from '../helpers/fake-context';

const GLOBAL = 'core_calendar_get_action_events_by_timesort';
const BY_COURSE = 'core_calendar_get_action_events_by_course';
const NOW = new Date('2026-10-14T03:00:00Z'); // 2026-10-14 12:00 JST
const NOW_SEC = 1791946800;
const DAY = 86_400;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
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

describe('getDueItems', () => {
  it('queries the default window and returns the merged list', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [GLOBAL]: eventsFixture } });
    const list = await getDueItems(ctx);
    expect(api.calls).toEqual([
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
      hiddenCourseCount: 0,
      truncated: false,
    });
    expect(list.items.map((i) => i.name)).toEqual(ALL_NAMES);
  });

  it('drops and counts items of courses hidden in settings', async () => {
    const { ctx } = makeFakeContext({
      responses: { [GLOBAL]: eventsFixture },
      user: { settings: { hiddenCourseIds: [103] } },
    });
    const list = await getDueItems(ctx);
    expect(list.hiddenCourseCount).toBe(1);
    expect(list.items.map((i) => i.name)).toEqual(ALL_NAMES.filter((n) => n !== 'Elective Essay'));
  });

  it('clamps the window (max 120 days ahead, 60 days back) and honours small values', async () => {
    const big = makeFakeContext({ responses: { [GLOBAL]: { events: [] } } });
    await getDueItems(big.ctx, { daysAhead: 500, overdueDays: 100 });
    expect(big.api.calls[0]?.params).toMatchObject({
      timesortfrom: NOW_SEC - 60 * DAY,
      timesortto: NOW_SEC + 120 * DAY,
    });

    const small = makeFakeContext({ responses: { [GLOBAL]: { events: [] } } });
    await getDueItems(small.ctx, { daysAhead: 3, overdueDays: 0 });
    expect(small.api.calls[0]?.params).toMatchObject({ timesortfrom: NOW_SEC, timesortto: NOW_SEC + 3 * DAY });
  });

  it('pages with aftereventid until a short page', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [GLOBAL]: pagedFeed([50, 50, 10]) } });
    const list = await getDueItems(ctx);
    expect(api.count(GLOBAL)).toBe(3);
    expect(api.calls.map((c) => c.params.aftereventid)).toEqual([undefined, 1049, 1099]);
    expect(list.items).toHaveLength(110);
    expect(list.truncated).toBe(false);
  });

  it('stops after 4 pages and reports truncation', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [GLOBAL]: pagedFeed([50, 50, 50, 50, 50, 50]) } });
    const list = await getDueItems(ctx);
    expect(api.count(GLOBAL)).toBe(4);
    expect(list.items).toHaveLength(200);
    expect(list.truncated).toBe(true);
  });

  it('does not report truncation when the last full page is followed by an empty one', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [GLOBAL]: pagedFeed([50, 0]) } });
    const list = await getDueItems(ctx);
    expect(api.count(GLOBAL)).toBe(2);
    expect(list.truncated).toBe(false);
  });

  it('rejects an invalid course id', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [GLOBAL]: { events: [] } } });
    await expect(getDueItems(ctx, { courseId: 0 })).rejects.toBeInstanceOf(InvalidInput);
    expect(api.calls).toHaveLength(0);
  });

  it('uses the per-course feed when a course is requested (even a hidden one)', async () => {
    const { ctx, api } = makeFakeContext({
      responses: { [BY_COURSE]: eventsFixture },
      user: { settings: { hiddenCourseIds: [101] } },
    });
    const list = await getDueItems(ctx, { courseId: 101 });
    expect(api.calls).toEqual([
      {
        fn: BY_COURSE,
        params: { courseid: 101, timesortfrom: NOW_SEC - 14 * DAY, timesortto: NOW_SEC + 14 * DAY, limitnum: 50 },
      },
    ]);
    expect(list.items.map((i) => i.name)).toEqual(['Report 0', 'Report 1', 'Quiz A']);
    expect(list.hiddenCourseCount).toBe(0);
  });

  it('falls back to the global feed (filtered) when the per-course function is unavailable', async () => {
    const { ctx, api } = makeFakeContext({
      responses: {
        [BY_COURSE]: new MoodleError('Access control exception', 'accessexception'),
        [GLOBAL]: eventsFixture,
      },
    });
    const list = await getDueItems(ctx, { courseId: 101 });
    expect(api.calls.map((c) => c.fn)).toEqual([BY_COURSE, GLOBAL]);
    expect(list.items.map((i) => i.name)).toEqual(['Report 0', 'Report 1', 'Quiz A']);
  });
});
