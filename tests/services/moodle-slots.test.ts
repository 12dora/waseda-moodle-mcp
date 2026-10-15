import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import { BudgetExceeded, MoodleError, MoodleUnavailable, NeedsReconnect } from '../../src/core/errors';
import { inferSchedules, schedulesFromEvents } from '../../src/core/services/timetable/moodle-slots';
import type { InferredSchedule } from '../../src/core/types';
import { MemoryStore } from '../../src/node/store-memory';
import { makeFakeContext } from '../helpers/fake-context';

const EVENTS = 'core_calendar_get_calendar_events';
const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-15T03:00:00Z'); // 2026-10-15 12:00 JST
const COURSE = 300907; // 総合日本語３Ｘ

const sec = (jst: string) => Date.parse(`${jst}:00+09:00`) / 1000;

interface Ev {
  courseid: number;
  eventtype: string;
  name: string;
  timestart: number;
  timeduration: number;
  modulename?: string;
}

const attendance = (jst: string, over: Partial<Ev> = {}, courseid = COURSE): Ev => ({
  courseid,
  eventtype: 'attendance',
  name: '出席・欠席の記録（対面授業）',
  timestart: sec(jst),
  timeduration: 6000,
  ...over,
});

/** The 対面 block of 総合日本語３Ｘ: Fridays 1限 + 2限 as two 100-minute events each. */
const fridays = (dates: string[], courseid = COURSE): Ev[] =>
  dates.flatMap((d) => [attendance(`${d}T08:50`, {}, courseid), attendance(`${d}T10:40`, {}, courseid)]);

const FRIDAYS = ['2026-10-02', '2026-10-09', '2026-10-16'];
const FRI_1_2 = { weekday: 5, periodFrom: 1, periodTo: 2, night: false, classroom: null };

describe('schedulesFromEvents', () => {
  it('turns a 2-period attendance block into P1–2 on Friday with the first and last session date', () => {
    const out = schedulesFromEvents(fridays(FRIDAYS), 1234);
    expect(out.get(COURSE)).toEqual({
      slots: [FRI_1_2],
      firstDate: '2026-10-02',
      lastDate: '2026-10-16',
      checkedAt: 1234,
    });
    expect(out.size).toBe(1);
  });

  it('ignores a one-off event and a period seen on one date only', () => {
    expect(schedulesFromEvents(fridays(['2026-10-02']), 1).size).toBe(0);
    const extra = [...fridays(FRIDAYS), attendance('2026-10-12T13:10'), attendance('2026-10-13T08:50')];
    expect(schedulesFromEvents(extra, 1).get(COURSE)?.slots).toEqual([FRI_1_2]);
  });

  it('ignores on-demand attendance (all-day window, or a regular-length one named on-demand)', () => {
    const allDay = ['2026-10-01', '2026-10-08', '2026-10-15'].map((d) =>
      attendance(`${d}T00:00`, { timeduration: 86_340, name: '出席・欠席の記録（オンデマンド）' }),
    );
    const named = fridays(FRIDAYS).map((e) => ({ ...e, name: 'オンデマンド授業の出席' }));
    const english = fridays(FRIDAYS).map((e) => ({ ...e, name: 'On-Demand attendance' }));
    expect(schedulesFromEvents([...allDay, ...named, ...english], 1).size).toBe(0);
  });

  it('ignores open/due events at 13:10 and events that are not attendance', () => {
    const open = FRIDAYS.map((d) => attendance(`${d}T13:10`, { eventtype: 'open', timeduration: 0 }));
    const quiz = FRIDAYS.map((d) => attendance(`${d}T13:10`, { eventtype: 'open', modulename: 'quiz' }));
    const user = fridays(FRIDAYS).map((e) => ({ ...e, eventtype: 'user' }));
    expect(schedulesFromEvents([...open, ...quiz, ...user], 1).size).toBe(0);
  });

  it('accepts modulename attendance, 90-minute sessions and rejects other lengths and off-grid starts', () => {
    const byModule = FRIDAYS.map((d) => attendance(`${d}T13:10`, { eventtype: 'course', modulename: 'attendance' }));
    const ninety = FRIDAYS.map((d) => attendance(`${d}T15:05`, { timeduration: 5400 }, 2));
    const short = FRIDAYS.map((d) => attendance(`${d}T08:50`, { timeduration: 3000 }, 3));
    const offGrid = FRIDAYS.map((d) => attendance(`${d}T09:00`, {}, 4));
    const out = schedulesFromEvents([...byModule, ...ninety, ...short, ...offGrid], 1);
    expect(out.get(COURSE)?.slots).toEqual([{ ...FRI_1_2, periodFrom: 3, periodTo: 3 }]);
    expect(out.get(2)?.slots).toEqual([{ ...FRI_1_2, periodFrom: 4, periodTo: 4 }]);
    expect([...out.keys()]).toEqual([COURSE, 2]);
  });

  it('maps weekday evening starts to the night clock (WBS 夜6-7) and keeps separate weekdays and gaps apart', () => {
    const tuesdays = ['2026-10-06', '2026-10-13'].flatMap((d) => [
      attendance(`${d}T18:30`, {}, 57),
      attendance(`${d}T20:20`, {}, 57),
    ]);
    const mondays = ['2026-10-05', '2026-10-12'].map((d) => attendance(`${d}T15:05`));
    const mixed = [...fridays(FRIDAYS.slice(0, 2)), ...mondays];
    const out = schedulesFromEvents([...tuesdays, ...mixed], 9);
    expect(out.get(57)?.slots).toEqual([{ weekday: 2, periodFrom: 6, periodTo: 7, night: true, classroom: null }]);
    expect(out.get(COURSE)?.slots).toEqual([
      { weekday: 1, periodFrom: 4, periodTo: 4, night: false, classroom: null },
      FRI_1_2,
    ]);
  });

  it('does not use the night clock on Saturday and reads Sunday as weekday 7', () => {
    const saturdays = ['2026-10-03', '2026-10-10'].map((d) => attendance(`${d}T18:30`));
    const sundays = ['2026-10-04', '2026-10-11'].map((d) => attendance(`${d}T08:50`, {}, 8));
    const out = schedulesFromEvents([...saturdays, ...sundays], 1);
    expect(out.has(COURSE)).toBe(false);
    expect(out.get(8)?.slots).toEqual([{ weekday: 7, periodFrom: 1, periodTo: 1, night: false, classroom: null }]);
  });
});

describe('inferSchedules', () => {
  const start = sec('2026-09-21T00:00');
  const end = sec('2027-03-31T00:00');
  const course = { id: COURSE, start, end };
  let store: MemoryStore;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    store = new MemoryStore();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (events: unknown = { events: fridays(FRIDAYS) }) => {
    const t = makeFakeContext({ responses: { [EVENTS]: events } });
    const ctx: ServiceContext = { ...t.ctx, store, user: { ...t.ctx.user, id: 1 } };
    return { t, ctx };
  };
  const cached = () => store.getInferredSchedules(1);
  const entry = (checkedAt: number, slots: InferredSchedule['slots'] = []): InferredSchedule => ({
    slots,
    firstDate: null,
    lastDate: null,
    checkedAt,
  });

  it('on a cache miss makes ONE calendar call for all courses and caches every answer', async () => {
    const { t, ctx } = setup({ events: [...fridays(FRIDAYS), attendance('2026-10-01T08:50', {}, 99)] });
    const out = await inferSchedules(ctx, [course, { id: 99, start: null, end: null }, { id: 5, start: 0, end: 0 }]);

    expect([...out.keys()]).toEqual([COURSE]);
    expect(out.get(COURSE)).toMatchObject({ slots: [FRI_1_2], firstDate: '2026-10-02', checkedAt: NOW.getTime() });
    expect(t.api.count(EVENTS)).toBe(1);
    expect(t.api.calls[0]?.params).toEqual({
      events: { courseids: [COURSE, 99, 5] },
      options: { userevents: 0, siteevents: 0, timestart: start, timeend: end },
    });
    await Promise.all(t.deferred);
    const rows = await cached();
    expect([...rows.keys()].sort((a, b) => a - b)).toEqual([5, 99, 300907]);
    expect(rows.get(5)).toEqual(entry(NOW.getTime())); // "looked, found none" is cached too
    expect(rows.get(99)?.slots).toEqual([]); // one session only: a one-off
  });

  it('caps a course window that reaches outside the academic year', async () => {
    const { t, ctx } = setup({ events: [] });
    await inferSchedules(ctx, [{ id: COURSE, start: sec('2020-01-01T00:00'), end: sec('2090-01-01T00:00') }]);
    const options = t.api.calls[0]?.params.options as { timestart: number; timeend: number };
    expect(options.timestart).toBe(sec('2026-04-01T00:00'));
    expect(options.timeend).toBe(sec('2027-03-31T23:59') + 59);
  });

  it('serves a fresh cache without asking Moodle, empty answers included', async () => {
    const { t, ctx } = setup();
    await store.putInferredSchedules(
      1,
      new Map([
        [COURSE, entry(NOW.getTime() - DAY_MS, [FRI_1_2])],
        [6, entry(NOW.getTime())],
      ]),
    );
    const out = await inferSchedules(ctx, [course, { id: 6, start, end }]);
    expect([...out.keys()]).toEqual([COURSE]);
    expect(out.get(COURSE)?.slots).toEqual([FRI_1_2]);
    expect(t.api.count(EVENTS)).toBe(0);
    expect(t.api.callsMade).toBe(0);
  });

  it('asks only for the missing and the stale courses (older than 7 days)', async () => {
    const { t, ctx } = setup({ events: fridays(FRIDAYS, 7) });
    await store.putInferredSchedules(
      1,
      new Map([
        [COURSE, entry(NOW.getTime() - 2 * DAY_MS, [FRI_1_2])], // fresh
        [6, entry(NOW.getTime() - 8 * DAY_MS, [FRI_1_2])], // stale
      ]),
    );
    const out = await inferSchedules(ctx, [course, { id: 6, start, end }, { id: 7, start, end }]);
    expect(t.api.calls[0]?.params.events).toMatchObject({ courseids: [6, 7] });
    expect([...out.keys()].sort((a, b) => a - b)).toEqual([7, 300907]); // 6 was re-checked: nothing found any more
    await Promise.all(t.deferred);
    expect((await cached()).get(6)?.checkedAt).toBe(NOW.getTime());
  });

  it('returns a second call from the cache written by the first', async () => {
    const { t, ctx } = setup();
    await inferSchedules(ctx, [course]);
    await Promise.all(t.deferred);
    t.api.set(EVENTS, new MoodleError('should not be called'));
    expect((await inferSchedules(ctx, [course])).get(COURSE)?.slots).toEqual([FRI_1_2]);
    expect(t.api.count(EVENTS)).toBe(1);
  });

  it.each([
    ['a Moodle error', new MoodleError('no access', 'nopermissions')],
    ['Moodle being unreachable', new MoodleUnavailable()],
    ['the call budget', new BudgetExceeded()],
  ])('returns what the cache has (stale entries too) on %s and writes nothing', async (_name, error) => {
    const { t, ctx } = setup(error);
    await store.putInferredSchedules(1, new Map([[COURSE, entry(NOW.getTime() - 30 * DAY_MS, [FRI_1_2])]]));
    const out = await inferSchedules(ctx, [course, { id: 8, start, end }]);
    expect([...out.keys()]).toEqual([COURSE]);
    expect(t.api.count(EVENTS)).toBe(1);
    await Promise.all(t.deferred);
    expect((await cached()).get(COURSE)?.checkedAt).toBe(NOW.getTime() - 30 * DAY_MS);
    expect((await cached()).has(8)).toBe(false);
  });

  it('does not hide a reconnect request and does not fail on a broken cache write', async () => {
    const needs = setup(new NeedsReconnect());
    await expect(inferSchedules(needs.ctx, [course])).rejects.toBeInstanceOf(NeedsReconnect);

    const { t, ctx } = setup();
    vi.spyOn(store, 'putInferredSchedules').mockRejectedValue(new Error('D1 down'));
    expect((await inferSchedules(ctx, [course])).get(COURSE)?.slots).toEqual([FRI_1_2]);
    await expect(Promise.all(t.deferred)).resolves.toBeDefined();
  });

  it('makes no call for an empty list and de-duplicates course ids', async () => {
    const { t, ctx } = setup();
    expect((await inferSchedules(ctx, [])).size).toBe(0);
    expect(t.api.callsMade).toBe(0);
    await inferSchedules(ctx, [course, course]);
    expect(t.api.calls[0]?.params.events).toMatchObject({ courseids: [COURSE] });
  });
});
