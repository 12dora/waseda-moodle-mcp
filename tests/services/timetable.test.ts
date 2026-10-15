import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError } from '../../src/core/errors';
import type { SyllabusInfo, SyllabusSlot } from '../../src/core/services/syllabus';
import { classesOn, getTimetable } from '../../src/core/services/timetable';
import { ACADEMIC_CALENDAR, type AcademicCalendar } from '../../src/core/services/timetable/calendar';
import {
  inferredEntry,
  overrideEntry,
  syllabusEntry,
  type TimetableEntry,
} from '../../src/core/services/timetable/entries';
import { type Inference, inferSchedules } from '../../src/core/services/timetable/moodle-slots';
import { slotClock } from '../../src/core/services/timetable/periods';
import type { Course, InferredSchedule, ScheduleOverride } from '../../src/core/types';
import { MemoryStore } from '../../src/node/store-memory';
import { makeFakeContext } from '../helpers/fake-context';

vi.mock('../../src/core/services/timetable/moodle-slots', () => ({ inferSchedules: vi.fn() }));

const NOW = new Date('2026-10-14T03:00:00Z'); // Wed 2026-10-14 12:00 JST
const TIMELINE = 'core_course_get_enrolled_courses_by_timeline_classification';
const ENROL = 'core_enrol_get_users_courses';
const EVENTS = 'core_calendar_get_action_events_by_timesort';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.mocked(inferSchedules).mockReset();
  vi.mocked(inferSchedules).mockResolvedValue(inference());
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 500 })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ fixtures

const WBS_PKEY = '5700100062022026570010006257'; // school 57
const COM_PKEY = '1600000006012026160000000616'; // school 16

const slot = (weekday: number, periodFrom: number, periodTo = periodFrom, extra: Partial<SyllabusSlot> = {}) => ({
  weekday,
  periodFrom,
  periodTo,
  night: false,
  classroom: null,
  campus: null,
  ...extra,
});

const info = (term: string | null, slots: SyllabusSlot[], extra: Partial<SyllabusInfo> = {}): SyllabusInfo => ({
  pKey: COM_PKEY,
  year: 2026,
  term,
  dayPeriod: null,
  instructors: [],
  slots,
  onDemand: false,
  scheduleUnparsed: false,
  ...extra,
});

const entry = (id: number, name: string, i: SyllabusInfo): TimetableEntry =>
  syllabusEntry({ id, name, url: `https://moodle.example.edu/course/view.php?id=${id}` }, i);

const course = (id: number, name: string, extra: Partial<Course> = {}): Course => ({
  id,
  name,
  shortName: `C${id}`,
  category: null,
  url: `https://moodle.example.edu/course/view.php?id=${id}`,
  start: null,
  end: null,
  progress: null,
  kind: 'class',
  mine: true,
  suggested: false,
  term: null,
  lastAccess: null,
  ...extra,
});

const inferred = (slots: InferredSchedule['slots'], firstDate: string | null, lastDate: string | null) => ({
  slots,
  firstDate,
  lastDate,
  checkedAt: NOW.getTime(),
});
const friP1_2 = { weekday: 5, periodFrom: 1, periodTo: 2, night: false, classroom: null };

/** What inferSchedules answers: `checked` defaults to the courses with a schedule. */
function inference(found: Map<number, InferredSchedule> = new Map(), checked = [...found.keys()]): Inference {
  return { found, checked: new Set(checked) };
}

const names = (iso: string, entries: TimetableEntry[], calendar?: AcademicCalendar) =>
  classesOn(iso, entries, calendar).classes.map((c) => c.courseName);

// ------------------------------------------------------------------ period clocks

describe('slotClock', () => {
  it('uses the official 全体 table, 7限 is 50 minutes', () => {
    expect(slotClock(slot(1, 1, 2))).toEqual({ start: '08:50', end: '12:20' });
    expect(slotClock(slot(2, 3))).toEqual({ start: '13:10', end: '14:50' });
    expect(slotClock(slot(3, 4, 5))).toEqual({ start: '15:05', end: '18:40' });
    expect(slotClock(slot(4, 6))).toEqual({ start: '18:55', end: '20:35' });
    expect(slotClock(slot(5, 7))).toEqual({ start: '20:45', end: '21:35' });
  });

  it('uses the night clock for weekday 夜 slots but 全体 on Saturday', () => {
    expect(slotClock(slot(4, 6, 7, { night: true }))).toEqual({ start: '18:30', end: '22:00' });
    expect(slotClock(slot(1, 6, 6, { night: true }))).toEqual({ start: '18:30', end: '20:10' });
    expect(slotClock(slot(5, 7, 7, { night: true }))).toEqual({ start: '20:20', end: '22:00' });
    expect(slotClock(slot(6, 6, 6, { night: true }))).toEqual({ start: '18:55', end: '20:35' });
    expect(slotClock(slot(6, 5, 6))).toEqual({ start: '17:00', end: '20:35' });
  });

  it('is null for a period without a clock', () => {
    expect(slotClock(slot(1, 8))).toBeNull();
  });
});

// ------------------------------------------------------------------ classesOn

describe('classesOn: terms and calendar (AY2026)', () => {
  const mon = entry(1, 'Mon fall-Q', info('秋クォーター', [slot(1, 1, 2)]));
  const fri = entry(2, 'Fri fall-sem', info('秋学期', [slot(5, 2)]));
  const thuWinter = entry(3, 'Thu winter-Q', info('冬クォーター', [slot(4, 1, 2)]));
  const thuNight = entry(4, 'Thu night', info('秋クォーター', [slot(4, 6, 7, { night: true })]));
  const all = [mon, fri, thuWinter, thuNight];

  it('Thursday 2026-10-08: only the evening class (the winter course has not started)', () => {
    const day = classesOn('2026-10-08', all);
    expect(day.weekday).toBe(4);
    expect(day.classes.map((c) => [c.courseName, c.start, c.end, c.periods])).toEqual([
      ['Thu night', '18:30', '22:00', 'P6–7'],
    ]);
  });

  it('a holiday on which classes are held runs that weekday and says so', () => {
    const day = classesOn('2026-10-12', all);
    expect(day.classes.map((c) => c.courseName)).toEqual(['Mon fall-Q']);
    expect(day.classes[0]).toMatchObject({ start: '08:50', end: '12:20', periods: 'P1–2', night: false });
    expect(day.notes).toEqual([{ kind: 'held', name: 'スポーツの日' }]);
  });

  it.each([
    ['2026-11-05', '臨時の休業日'],
    ['2026-12-25', '臨時の休業日'],
    ['2026-11-07', '早稲田祭'],
    ['2027-01-11', '成人の日'],
  ])('%s has no classes (%s)', (date, why) => {
    const day = classesOn(date, [
      ...all,
      entry(5, 'Sat', info('秋学期', [slot(6, 1)])),
      entry(6, 'Mon', info('秋学期', [slot(1, 1)])),
    ]);
    expect(day.classes).toEqual([]);
    expect(day.notes).toEqual([{ kind: 'closed', name: why }]);
  });

  it('2026-11-23: 勤労感謝の日 is a class day; 冬クォーター starts, 秋クォーター ended 11-21', () => {
    const monWinter = entry(7, 'Mon winter-Q', info('冬クォーター', [slot(1, 3)]));
    const monFallSem = entry(8, 'Mon fall-sem', info('秋学期', [slot(1, 4)]));
    expect(names('2026-11-23', [mon, monWinter, monFallSem])).toEqual(['Mon winter-Q', 'Mon fall-sem']);
    expect(names('2026-11-16', [mon, monWinter, monFallSem])).toEqual(['Mon fall-Q', 'Mon fall-sem']);
  });

  it('winter break 12-22 .. 01-05 has no classes, class resumes 01-06', () => {
    const wed = entry(9, 'Wed', info('秋学期', [slot(3, 1)]));
    expect(classesOn('2026-12-23', [wed]).classes).toEqual([]);
    expect(classesOn('2026-12-23', [wed]).notes).toEqual([{ kind: 'winter-break' }]);
    expect(names('2026-12-16', [wed])).toEqual(['Wed']);
    expect(names('2027-01-06', [wed])).toEqual(['Wed']);
  });

  it('WBS / CJL end on 2027-01-26, the university on 2027-02-02', () => {
    const wbs = entry(10, 'WBS Tue', info('秋学期', [slot(2, 1)], { pKey: WBS_PKEY }));
    const com = entry(11, 'Commerce Tue', info('秋学期', [slot(2, 1)]));
    expect(names('2027-01-26', [wbs, com])).toEqual(['Commerce Tue', 'WBS Tue']);
    expect(names('2027-02-02', [wbs, com])).toEqual(['Commerce Tue']);
    expect(names('2027-02-09', [wbs, com])).toEqual([]);
  });

  it('every class day before the autumn start and in the summer break is empty, with a note', () => {
    const day = classesOn('2026-08-18', [entry(12, 'Tue', info('秋学期', [slot(2, 1)]))]);
    expect(day.classes).toEqual([]);
    expect(day.notes).toEqual([{ kind: 'term-break' }]);
  });

  it('通年 runs in both semesters; a missing term counts as a semester course; 集中 never meets', () => {
    const year = entry(13, 'Year Wed', info('通年', [slot(3, 1)]));
    const noTerm = entry(14, 'No term Wed', info(null, [slot(3, 2)]));
    const block = entry(15, 'Block', info('集中', [slot(3, 3)]));
    expect(names('2026-05-13', [year, noTerm, block])).toEqual(['Year Wed', 'No term Wed']);
    expect(names('2026-10-14', [year, noTerm, block])).toEqual(['Year Wed', 'No term Wed']);
    expect(names('2026-08-19', [year, noTerm, block])).toEqual([]);
  });

  it('sorts a day by start time and keeps every slot of a multi-slot course', () => {
    const multi = entry(16, 'Multi', info('秋学期', [slot(3, 3, 4, { classroom: '22-208' }), slot(5, 1)]));
    const early = entry(17, 'Early', info('秋学期', [slot(3, 1)]));
    const day = classesOn('2026-10-14', [multi, early]);
    expect(day.classes.map((c) => [c.courseName, c.start])).toEqual([
      ['Early', '08:50'],
      ['Multi', '13:10'],
    ]);
    expect(day.classes[1]).toMatchObject({ end: '16:45', classroom: '22-208', courseId: 16 });
    expect(names('2026-10-16', [multi, early])).toEqual(['Multi']);
  });

  it('spring-side AY2026 holidays: 昭和の日 held, Golden Week closed, 7/20 held', () => {
    const wed = entry(18, 'Wed', info('春学期', [slot(3, 1)]));
    const mon = entry(19, 'Mon', info('春学期', [slot(1, 1)]));
    expect(names('2026-04-29', [wed])).toEqual(['Wed']);
    expect(classesOn('2026-05-06', [wed]).classes).toEqual([]);
    expect(names('2026-07-20', [mon])).toEqual(['Mon']);
  });
});

describe('classesOn: 振替 days', () => {
  const calendar: AcademicCalendar = { ...ACADEMIC_CALENDAR, weekdayOverride: { '2026-10-20': 1 } };
  const mon = entry(1, 'Monday course', info('秋学期', [slot(1, 1)]));
  const tue = entry(2, 'Tuesday course', info('秋学期', [slot(2, 1)]));

  it('a Tuesday that follows the Monday schedule runs Monday courses only', () => {
    const day = classesOn('2026-10-20', [mon, tue], calendar);
    expect(day.weekday).toBe(2);
    expect(day.classes.map((c) => c.courseName)).toEqual(['Monday course']);
    expect(day.notes).toEqual([{ kind: 'swap', weekday: 1 }]);
  });

  it('other dates keep their own weekday', () => {
    expect(names('2026-10-19', [mon, tue], calendar)).toEqual(['Monday course']);
    expect(names('2026-10-27', [mon, tue], calendar)).toEqual(['Tuesday course']);
  });
});

describe('classesOn: other academic years', () => {
  it('applies the month rules without holiday knowledge', () => {
    const mon = entry(1, 'Mon', info('秋クォーター', [slot(1, 1)], { year: 2027 }));
    expect(names('2027-10-04', [mon])).toEqual(['Mon']);
    expect(names('2027-11-29', [mon])).toEqual([]);
    expect(classesOn('2027-10-11', [mon]).notes).toEqual([]); // スポーツの日 unknown: treated as a class day
  });
});

// ------------------------------------------------------------------ getTimetable

const ID_A = '2026570010006202'; // WBS night course
const ID_B = '2026160000000601'; // commerce
const ID_C = '2026160000000702'; // on-demand
const ID_D = '2026160000000803'; // intensive
const ID_E = '2026160000000904'; // no syllabus

const RAW = (id: number, idnumber: string, name: string, extra: { startdate?: number; enddate?: number } = {}) => ({
  id,
  fullname: name,
  shortname: `C${id}`,
  idnumber,
  ...extra,
});

function setup(opts: { mine?: number[] | null; courses?: Array<ReturnType<typeof RAW>> } = {}) {
  const courses = opts.courses ?? [
    RAW(1, ID_A, 'Strategy (night)'),
    RAW(2, ID_B, 'Logic B'),
    RAW(3, ID_C, 'Online Japanese'),
    RAW(4, ID_D, 'Intensive Seminar'),
    RAW(5, ID_E, 'No Syllabus Course'),
    RAW(6, '2020ZZT900001408', 'Library Guide'),
  ];
  const t = makeFakeContext({
    user: { settings: { myCourseIds: opts.mine === undefined ? [1, 2, 3, 4, 5, 6] : opts.mine } },
    responses: {
      [TIMELINE]: { courses },
      [ENROL]: courses.map((c) => ({ id: c.id, lastaccess: 0 })),
      [EVENTS]: { events: [] },
    },
  });
  const seed = (idnumber: string, value: SyllabusInfo | null) =>
    t.state.syllabusCache.set(idnumber, { json: JSON.stringify(value), fetchedAt: NOW.getTime() });
  return { t, seed };
}

function seedAll(seed: (idnumber: string, value: SyllabusInfo | null) => void) {
  seed(
    ID_A,
    info('秋クォーター', [slot(4, 6, 7, { night: true, classroom: '11-909(馬蹄形)', campus: '早稲田' })], {
      pKey: WBS_PKEY,
    }),
  );
  seed(ID_B, info('秋学期', [slot(3, 3), slot(5, 1, 2, { classroom: '11-507' })]));
  seed(ID_C, info('秋学期', [], { onDemand: true }));
  seed(ID_D, info('集中', []));
  seed(ID_E, null);
}

describe('getTimetable', () => {
  it('lists today by default with real times, rooms and a course link; routes the rest to separate lists', async () => {
    const { t, seed } = setup();
    seedAll(seed);
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const res = await getTimetable(t.ctx);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(res).toMatchObject({ from: '2026-10-14', to: '2026-10-14', scopeMode: 'mine', approximate: false });
    expect(res.days).toHaveLength(1);
    expect(res.days[0]).toMatchObject({ date: '2026-10-14', weekday: 3, notes: [] });
    expect(res.days[0]?.classes).toEqual([
      {
        courseId: 2,
        courseName: 'Logic B',
        start: '13:10',
        end: '14:50',
        periods: 'P3',
        periodFrom: 3,
        periodTo: 3,
        night: false,
        classroom: null,
        campus: null,
        url: 'https://moodle.example.edu/course/view.php?id=2',
        source: 'syllabus',
      },
    ]);
    expect(res.onDemand.map((c) => [c.courseId, c.kind, c.term, c.alsoInClass])).toEqual([
      [3, 'on-demand', '秋学期', false],
      [4, 'no-fixed-time', '集中', false],
    ]);
    expect(res.unknown.map((c) => c.courseId)).toEqual([5]); // the ZZ course is not a class
    expect(res.periodTimes.standard).toHaveLength(7);
    expect(res.periodTimes.evening).toEqual([
      { period: 6, start: '18:30', end: '20:10' },
      { period: 7, start: '20:20', end: '22:00' },
    ]);
  });

  it('covers a range: Wednesday class, a held holiday, closed days, 早稲田祭', async () => {
    const { t, seed } = setup();
    seedAll(seed);
    const res = await getTimetable(t.ctx, { date: '2026-11-02', days: 7 });
    const closed = (name: string) => [{ kind: 'closed', name }];
    expect(res.days.map((d) => [d.date, d.classes.map((c) => c.courseId), d.notes])).toEqual([
      ['2026-11-02', [], []],
      ['2026-11-03', [], [{ kind: 'held', name: '文化の日' }]],
      ['2026-11-04', [2], []],
      ['2026-11-05', [], closed('臨時の休業日')],
      ['2026-11-06', [], closed('臨時の休業日')],
      ['2026-11-07', [], closed('早稲田祭')],
      ['2026-11-08', [], closed('早稲田祭')],
    ]);
  });

  it('accepts tomorrow and an explicit date and shows the night clock', async () => {
    const { t, seed } = setup();
    seedAll(seed);
    expect((await getTimetable(t.ctx, { date: 'tomorrow' })).days[0]).toMatchObject({ date: '2026-10-15', weekday: 4 });
    const thu = (await getTimetable(t.ctx, { date: '2026-10-15' })).days[0];
    expect(thu?.classes[0]).toMatchObject({
      courseId: 1,
      start: '18:30',
      end: '22:00',
      periods: 'P6–7',
      night: true,
      classroom: '11-909(馬蹄形)',
      campus: '早稲田',
    });
  });

  it('only my courses count, and an on-demand course of a term outside the range is not listed', async () => {
    const { t, seed } = setup({ mine: [1, 3] });
    seedAll(seed);
    seed(ID_C, info('冬クォーター', [], { onDemand: true }));
    const res = await getTimetable(t.ctx, { date: '2026-10-14', days: 3 });
    expect(res.days.flatMap((d) => d.classes.map((c) => c.courseId))).toEqual([1]);
    expect(res.onDemand).toEqual([]);
    expect(res.unknown).toEqual([]);
  });

  it('flags dates outside AY2026 as approximate', async () => {
    const { t, seed } = setup();
    seedAll(seed);
    expect((await getTimetable(t.ctx, { date: '2027-04-05' })).approximate).toBe(true);
    expect((await getTimetable(t.ctx, { date: '2027-03-30', days: 3 })).approximate).toBe(true);
    expect((await getTimetable(t.ctx, { date: '2027-03-29', days: 3 })).approximate).toBe(false);
  });

  it("a new user's courses are all fetched on the first call, shared with the course scope", async () => {
    const { t } = setup();
    const page = (cell: string) =>
      `<html><body><table><tr><th scope="row">学期曜日時限</th><td>${cell}</td></tr></table></body></html>`;
    const fetchFn = vi.fn(async () => new Response(page('秋学期&nbsp;&nbsp;月１時限')));
    vi.stubGlobal('fetch', fetchFn);
    const res = await getTimetable(t.ctx, { date: '2026-10-12', days: 14 });
    expect(fetchFn).toHaveBeenCalledTimes(5); // once per course: the scope's lookup is reused, not repeated
    expect(res.days).toHaveLength(14);
    expect(res.days.filter((d) => d.classes.length > 0).map((d) => d.date)).toEqual(['2026-10-12', '2026-10-19']);
    expect(res.unknown).toEqual([]);
    expect(t.api.count(TIMELINE)).toBe(1);
  });

  it('serves the cache only when the syllabus lookup is switched off', async () => {
    const { t, seed } = setup();
    seed(ID_B, info('秋学期', [slot(3, 3)]));
    t.ctx.syllabusLookup = false;
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const res = await getTimetable(t.ctx);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(res.days[0]?.classes.map((c) => c.courseId)).toEqual([2]);
    expect(res.unknown.map((c) => [c.courseId, c.reason])).toEqual([
      [1, 'lookup-off'],
      [3, 'lookup-off'],
      [4, 'lookup-off'],
      [5, 'lookup-off'],
    ]);
  });

  it('rejects a bad date and a bad number of days', async () => {
    const { t } = setup();
    for (const date of ['2026-02-30', '10/14', 'yesterday', '2026-1-1', '1999-12-31', '2101-01-01']) {
      await expect(getTimetable(t.ctx, { date })).rejects.toBeInstanceOf(InvalidInput);
    }
    for (const days of [0, 15, 1.5, -1]) {
      await expect(getTimetable(t.ctx, { days })).rejects.toBeInstanceOf(InvalidInput);
    }
  });

  it('accepts the edge years 2000 and 2100', async () => {
    const { t } = setup();
    await expect(getTimetable(t.ctx, { date: '2000-01-01' })).resolves.toMatchObject({ approximate: true });
    await expect(getTimetable(t.ctx, { date: '2100-12-31' })).resolves.toMatchObject({ approximate: true });
  });
});

// ------------------------------------------------------------------ sources (contract §15.1)

const override = (o: Pick<ScheduleOverride, 'mode' | 'slots'> & { alsoOnDemand?: boolean }): ScheduleOverride => ({
  alsoOnDemand: false,
  ...o,
});
const userSlot = (
  weekday: number,
  periodFrom: number,
  periodTo = periodFrom,
  extra: Partial<ScheduleOverride['slots'][number]> = {},
) => ({ weekday, periodFrom, periodTo, night: false, classroom: null, ...extra });

describe("getTimetable: the user's own times", () => {
  function withOverrides(overrides: Record<string, ScheduleOverride>) {
    const made = setup();
    seedAll(made.seed);
    made.t.ctx.user.settings = { ...made.t.ctx.user.settings, scheduleOverrides: overrides };
    return made;
  }

  it('win over the syllabus; none and on-demand are listed; overridden courses cost no lookup', async () => {
    const { t } = withOverrides({
      '2': override({ mode: 'slots', slots: [userSlot(1, 4, 5, { classroom: '22-101' })] }),
      '1': override({ mode: 'none', slots: [] }),
      '3': override({ mode: 'on-demand', slots: [] }),
    });
    const res = await getTimetable(t.ctx, { date: '2026-10-14', days: 7 });
    const found = res.days.flatMap((d) => d.classes.map((c) => [d.date, c.courseId, c.start, c.source, c.classroom]));
    expect(found).toEqual([['2026-10-19', 2, '15:05', 'user', '22-101']]); // the syllabus Wed / Fri classes are gone
    expect(res.days[0]?.classes).toEqual([]);
    expect(res.onDemand.map((c) => [c.courseId, c.kind, c.term, c.alsoInClass])).toEqual([
      [1, 'no-fixed-time', '秋クォーター', false], // the term of the syllabus, when it is known
      [3, 'on-demand', '秋学期', false],
      [4, 'no-fixed-time', '集中', false],
    ]);
    expect(res.unknown.map((c) => c.courseId)).toEqual([5]); // course 1 (none) is not unknown either
    expect(vi.mocked(inferSchedules).mock.calls[0]?.[1].map((c) => c.id)).toEqual([5]);
  });

  it('apply only inside the Moodle course dates when they are known, and never on closed days', async () => {
    const wed = overrideEntry(
      course(2, 'Wed', { start: '2026-10-14T00:00:00+09:00', end: '2026-10-21T00:00:00+09:00' }),
      override({ mode: 'slots', slots: [userSlot(3, 1)] }),
      null,
    );
    const open = overrideEntry(course(3, 'Open', {}), override({ mode: 'slots', slots: [userSlot(3, 1)] }), null);
    const dates = ['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04', '2026-08-19', '2026-12-23'];
    const hits = (e: TimetableEntry) => dates.filter((d) => classesOn(d, [e]).classes.length > 0);
    expect(hits(wed)).toEqual(['2026-10-14', '2026-10-21']);
    // an open window still needs a running term: not the summer or the winter break
    expect(hits(open)).toEqual(['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04']);
    expect(overrideEntry(course(4, 'None'), override({ mode: 'none', slots: [] }), null).listing).toBe('no-fixed-time');
  });
});

describe('getTimetable: Moodle attendance sessions', () => {
  const fri = (first: string, last: string): Inference => inference(new Map([[5, inferred([friP1_2], first, last)]]));

  it('fill in courses the syllabus does not know, asked once with the Moodle course dates', async () => {
    const { t, seed } = setup({
      courses: [
        RAW(5, ID_E, 'No Syllabus Course', { startdate: 1_790_000_000, enddate: 1_800_000_000 }),
        RAW(2, ID_B, 'B'),
      ],
    });
    seed(ID_B, info('秋学期', [slot(3, 3)]));
    seed(ID_E, null);
    vi.mocked(inferSchedules).mockResolvedValue(fri('2026-10-09', '2026-10-16'));
    const res = await getTimetable(t.ctx, { date: '2026-10-09', days: 14 });
    expect(vi.mocked(inferSchedules)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(inferSchedules).mock.calls[0]?.[1]).toEqual([{ id: 5, start: 1_790_000_000, end: 1_800_000_000 }]);
    const hits = res.days.flatMap((d) => d.classes.filter((c) => c.courseId === 5).map((c) => [d.date, c.source]));
    expect(hits).toEqual([
      ['2026-10-09', 'moodle'],
      ['2026-10-16', 'moodle'],
    ]); // inclusive first / last date; 10/23 is outside
    expect(res.unknown).toEqual([]);
  });

  it('skip closed days, and replace an unparsed syllabus time', async () => {
    const { t, seed } = setup({ courses: [RAW(5, ID_E, 'Unparsed')] });
    seed(ID_E, info('秋学期', [], { scheduleUnparsed: true }));
    vi.mocked(inferSchedules).mockResolvedValue(fri('2026-10-16', '2026-12-25'));
    const res = await getTimetable(t.ctx, { date: '2026-12-25', days: 1 });
    expect(res.days[0]).toMatchObject({ classes: [], notes: [{ kind: 'closed', name: '臨時の休業日' }] });
    const before = await getTimetable(t.ctx, { date: '2026-10-16' });
    expect(before.days[0]?.classes.map((c) => [c.courseId, c.source])).toEqual([[5, 'moodle']]);
  });

  it('are not asked for when the syllabus already gives slots, on-demand or an intensive course', async () => {
    const { t, seed } = setup();
    seedAll(seed);
    seed(ID_E, info('秋学期', [slot(2, 1)]));
    await getTimetable(t.ctx);
    expect(vi.mocked(inferSchedules)).not.toHaveBeenCalled();
  });
});

describe('getTimetable: which syllabus slots apply', () => {
  it("only in the course's own academic year; intensive courses too", async () => {
    const { t, seed } = setup({
      courses: [
        RAW(2, '2025160000000601', 'Old B'),
        RAW(3, '2025160000000702', 'Old C'),
        RAW(4, '2025160000000803', 'Old intensive'),
        RAW(5, ID_D, 'Intensive 2026'),
      ],
    });
    seed('2025160000000601', info('秋学期', [slot(3, 3)], { year: 2025 }));
    seed('2025160000000702', info('秋学期', [], { onDemand: true, year: 2025 }));
    seed('2025160000000803', info('集中', [], { year: 2025 }));
    seed(ID_D, info('集中', []));
    const res = await getTimetable(t.ctx, { date: '2026-10-14' });
    expect(res.days[0]?.classes).toEqual([]);
    expect(res.onDemand.map((c) => c.courseId)).toEqual([5]);
  });

  it('a slot of AY2026 is not applied to the dates of AY2027', async () => {
    const { t, seed } = setup({ mine: [2] });
    seed(ID_B, info('春学期', [slot(3, 3)]));
    expect((await getTimetable(t.ctx, { date: '2027-04-14' })).days[0]?.classes).toEqual([]);
    expect((await getTimetable(t.ctx, { date: '2026-04-15' })).days[0]?.classes.map((c) => c.courseId)).toEqual([2]);
  });

  it('with a joined term list: any of the terms covers the date', async () => {
    const { t, seed } = setup({ mine: [2] });
    seed(ID_B, info('春学期／秋学期', [slot(3, 3)]));
    const days = async (date: string) => (await getTimetable(t.ctx, { date })).days[0]?.classes.length;
    expect(await days('2026-05-13')).toBe(1);
    expect(await days('2026-10-14')).toBe(1);
    expect(await days('2026-08-19')).toBe(0);
    seed(ID_B, info('春クォーター／冬クォーター', [slot(3, 3)]));
    expect(await days('2026-05-13')).toBe(1);
    expect(await days('2026-10-14')).toBe(0);
    expect(await days('2026-12-16')).toBe(1);
  });

  it('a 集中 course with a parsed slot is listed as no fixed time, not put in the grid or dropped', async () => {
    const { t, seed } = setup({ mine: [4] });
    seed(ID_D, info('集中', [slot(3, 3)]));
    const res = await getTimetable(t.ctx, { date: '2026-10-14', days: 7 });
    expect(res.days.flatMap((d) => d.classes)).toEqual([]);
    expect(res.onDemand.map((c) => [c.courseId, c.kind, c.alsoInClass])).toEqual([[4, 'no-fixed-time', false]]);
  });

  it('an on-demand course that also meets is a hybrid: in the grid and flagged in the list', async () => {
    const { t, seed } = setup({ mine: [3] });
    seed(ID_C, info('秋学期', [slot(3, 1)], { onDemand: true }));
    const res = await getTimetable(t.ctx, { date: '2026-10-14' });
    expect(res.days[0]?.classes.map((c) => [c.courseId, c.start])).toEqual([[3, '08:50']]);
    expect(res.onDemand.map((c) => [c.courseId, c.kind, c.alsoInClass])).toEqual([[3, 'on-demand', true]]);
  });
});

describe('getTimetable: unknown reasons', () => {
  it('unparsed, pending, not-found and lookup-off', async () => {
    const { t, seed } = setup({ mine: [2, 3, 5] });
    seed(ID_B, info('秋学期', [], { scheduleUnparsed: true }));
    seed(ID_C, info('秋学期', [], {})); // 無その他: no fixed time, not unknown
    seed(ID_E, null);
    const reasons = async () => (await getTimetable(t.ctx)).unknown.map((c) => [c.courseId, c.reason]);
    expect(await reasons()).toEqual([
      [2, 'unparsed'],
      [5, 'pending'], // nothing could be asked of Moodle either
    ]);
    vi.mocked(inferSchedules).mockResolvedValue(inference(new Map(), [5])); // Moodle answered: nothing weekly
    expect(await reasons()).toEqual([
      [2, 'unparsed'],
      [5, 'not-found'],
    ]);
    t.ctx.syllabusLookup = false;
    expect(await reasons()).toEqual([
      [2, 'unparsed'],
      [5, 'lookup-off'],
    ]);
  });

  it('a syllabus saying 無その他 is listed as no fixed time, not as unknown', async () => {
    const { t, seed } = setup({ mine: [3] });
    seed(ID_C, info('秋学期', []));
    const res = await getTimetable(t.ctx);
    expect(res.unknown).toEqual([]);
    expect(res.onDemand.map((c) => [c.courseId, c.kind])).toEqual([[3, 'no-fixed-time']]);
  });
});

describe('getTimetable: a partly understood syllabus time', () => {
  const partial = () => info('秋学期', [slot(3, 3)], { scheduleUnparsed: true });

  it('is looked up in Moodle too, and what Moodle finds replaces it', async () => {
    const { t, seed } = setup({ mine: [2] });
    seed(ID_B, partial());
    const seen = new Map([[2, inferred([friP1_2], '2026-10-09', '2026-12-18')]]);
    vi.mocked(inferSchedules).mockResolvedValue(inference(seen));
    const res = await getTimetable(t.ctx, { date: '2026-10-14', days: 3 });
    expect(vi.mocked(inferSchedules).mock.calls[0]?.[1].map((c) => c.id)).toEqual([2]);
    const found = res.days.flatMap((d) => d.classes.map((c) => [d.date, c.courseId, c.source]));
    expect(found).toEqual([['2026-10-16', 2, 'moodle']]); // not the syllabus Wednesday
    expect(res.unknown).toEqual([]);
  });

  it('is kept when Moodle finds nothing, and the course is listed as unparsed', async () => {
    const { t, seed } = setup({ mine: [2] });
    seed(ID_B, partial());
    vi.mocked(inferSchedules).mockResolvedValue(inference(new Map(), [2]));
    const res = await getTimetable(t.ctx, { date: '2026-10-14' });
    expect(res.days[0]?.classes.map((c) => [c.courseId, c.source, c.start])).toEqual([[2, 'syllabus', '13:10']]);
    expect(res.unknown.map((c) => [c.courseId, c.reason])).toEqual([[2, 'unparsed']]);
  });

  it('keeps a partly understood on-demand course in the list and as unparsed', async () => {
    const { t, seed } = setup({ mine: [3] });
    seed(ID_C, info('秋学期', [], { onDemand: true, scheduleUnparsed: true }));
    const res = await getTimetable(t.ctx, { date: '2026-10-14' });
    expect(res.onDemand.map((c) => [c.courseId, c.kind])).toEqual([[3, 'on-demand']]);
    expect(res.unknown.map((c) => [c.courseId, c.reason])).toEqual([[3, 'unparsed']]);
  });
});

describe('getTimetable: unknown reasons with the real Moodle lookup', () => {
  const INFER = '../../src/core/services/timetable/moodle-slots';
  const EVENTS_FN = 'core_calendar_get_calendar_events';

  /** The real inferSchedules on a context whose inferred-schedule cache is a memory store. */
  async function realInference() {
    const real = await vi.importActual<typeof import('../../src/core/services/timetable/moodle-slots')>(INFER);
    vi.mocked(inferSchedules).mockImplementation(real.inferSchedules);
    const { t, seed } = setup({ mine: [5], courses: [RAW(5, ID_E, 'No Syllabus Course')] });
    seed(ID_E, null);
    const mem = new MemoryStore();
    const own: Record<PropertyKey, unknown> = {
      getInferredSchedules: mem.getInferredSchedules.bind(mem),
      putInferredSchedules: mem.putInferredSchedules.bind(mem),
    };
    const store = new Proxy(t.ctx.store, {
      get: (target, prop, receiver) => (prop in own ? own[prop] : Reflect.get(target, prop, receiver)),
    });
    return { t, mem, ctx: { ...t.ctx, store } };
  }

  it('a course Moodle already checked (cached empty answer) is not-found, not pending forever', async () => {
    const { t, mem, ctx } = await realInference();
    await mem.putInferredSchedules(ctx.user.id, new Map([[5, inferred([], null, null)]]));
    const res = await getTimetable(ctx);
    expect(res.unknown.map((c) => [c.courseId, c.reason])).toEqual([[5, 'not-found']]);
    expect(t.api.count(EVENTS_FN)).toBe(0);
  });

  it('a fresh Moodle answer without attendance sessions is not-found and is cached for next time', async () => {
    const { t, mem, ctx } = await realInference();
    t.api.set(EVENTS_FN, { events: [] });
    expect((await getTimetable(ctx)).unknown.map((c) => c.reason)).toEqual(['not-found']);
    await Promise.all(t.deferred);
    expect((await mem.getInferredSchedules(ctx.user.id)).get(5)?.slots).toEqual([]);
  });

  it('stays pending while the syllabus is not known yet, even when Moodle found nothing', async () => {
    const { t, ctx } = await realInference();
    t.state.syllabusCache.clear(); // never fetched; the site cannot answer in this call
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 })),
    );
    t.api.set(EVENTS_FN, { events: [] });
    expect((await getTimetable(ctx)).unknown.map((c) => [c.courseId, c.reason])).toEqual([[5, 'pending']]);
  });

  it('stays pending only while Moodle could not be asked', async () => {
    const { t, ctx } = await realInference();
    t.api.set(EVENTS_FN, new MoodleError('no access', 'nopermissions'));
    expect((await getTimetable(ctx)).unknown.map((c) => [c.courseId, c.reason])).toEqual([[5, 'pending']]);
  });
});

describe('getTimetable: user times, night clock and hybrids', () => {
  it('uses the evening clock of a night slot and lists an alsoOnDemand course as a hybrid', async () => {
    const { t, seed } = setup({ mine: [1, 2] });
    seedAll(seed);
    const scheduleOverrides = {
      '1': override({ mode: 'slots', slots: [userSlot(3, 6, 7, { night: true })] }),
      '2': override({ mode: 'slots', slots: [userSlot(3, 1)], alsoOnDemand: true }),
    };
    t.ctx.user.settings = { ...t.ctx.user.settings, scheduleOverrides };
    const res = await getTimetable(t.ctx, { date: '2026-10-14' });
    expect(res.days[0]?.classes.map((c) => [c.courseId, c.start, c.end, c.night, c.source])).toEqual([
      [2, '08:50', '10:30', false, 'user'],
      [1, '18:30', '22:00', true, 'user'],
    ]);
    expect(res.onDemand.map((c) => [c.courseId, c.kind, c.alsoInClass])).toEqual([[2, 'on-demand', true]]);
  });

  it('alsoOnDemand only makes a hybrid of a slots override', () => {
    const c = course(2, 'B');
    const slots = [userSlot(3, 1)];
    const hybrid = overrideEntry(c, override({ mode: 'slots', slots, alsoOnDemand: true }), null);
    expect([hybrid.listing, hybrid.alsoInClass]).toEqual(['on-demand', true]);
    const plain = overrideEntry(c, override({ mode: 'slots', slots }), null);
    expect([plain.listing, plain.alsoInClass]).toEqual([null, false]);
    const none = overrideEntry(c, override({ mode: 'none', slots: [], alsoOnDemand: true }), null);
    expect([none.listing, none.alsoInClass]).toEqual(['no-fixed-time', false]);
    const od = overrideEntry(c, override({ mode: 'on-demand', slots: [], alsoOnDemand: true }), null);
    expect([od.listing, od.alsoInClass]).toEqual(['on-demand', false]);
  });
});

describe('overrideEntry: when the user times apply', () => {
  const thursdays = override({ mode: 'slots', slots: [userSlot(4, 1)] });
  const hits = (e: TimetableEntry, dates: string[]) => dates.filter((d) => classesOn(d, [e]).classes.length > 0);

  it('inside the syllabus term of the course, with the short WBS / CJL calendar', () => {
    const wbs = overrideEntry(course(1, 'WBS'), thursdays, info('秋学期', [], { pKey: WBS_PKEY }));
    const commerce = overrideEntry(course(2, 'Commerce'), thursdays, info('秋学期', []));
    const dates = ['2027-01-21', '2027-01-28', '2027-02-04'];
    expect(hits(wbs, dates)).toEqual(['2027-01-21']); // WBS ends 01-26
    expect(hits(commerce, dates)).toEqual(['2027-01-21', '2027-01-28']); // the university ends 02-02
  });

  it('not outside that term, even when the Moodle course dates are open', () => {
    const spring = overrideEntry(course(3, 'Spring Q'), thursdays, info('春クォーター', []));
    expect(hits(spring, ['2026-05-14', '2026-10-15'])).toEqual(['2026-05-14']);
    expect(spring.coverage).toMatchObject({ kind: 'term', term: '春クォーター', year: 2026 });
  });

  it('uses the Moodle window when there is no usable syllabus term, one academic year when it has no end', () => {
    const openEnd = course(4, 'Open end', { start: '2026-09-21T00:00:00+09:00', end: null });
    const dates = ['2026-10-15', '2027-10-14'];
    expect(hits(overrideEntry(openEnd, thursdays, null), dates)).toEqual(['2026-10-15']);
    expect(hits(overrideEntry(openEnd, thursdays, info('集中', [])), dates)).toEqual(['2026-10-15']);
    expect(hits(overrideEntry(openEnd, thursdays, info(null, [])), dates)).toEqual(['2026-10-15']);
    const year = course(5, 'Both ends', { start: '2026-09-21T00:00:00+09:00', end: '2027-03-31T00:00:00+09:00' });
    expect(hits(overrideEntry(year, thursdays, null), ['2027-01-21', '2027-04-15'])).toEqual(['2027-01-21']);
  });
});

describe('inferredEntry', () => {
  const NOW_MS = NOW.getTime(); // 2026-10-14
  const fridays = ['2026-10-16', '2026-11-13', '2026-12-18', '2027-01-15', '2027-02-05'];
  const hits = (e: TimetableEntry | null) => fridays.filter((d) => e && classesOn(d, [e]).classes.length > 0);

  it('has no entry when Moodle showed no weekly meeting', () => {
    expect(inferredEntry(course(1, 'x'), inferred([], null, null), { info: null, now: NOW_MS })).toBeNull();
  });

  it('stops at an old last session; one still ahead (made in advance) runs to the term end', () => {
    const old = inferredEntry(course(5, 'Seen'), inferred([friP1_2], '2026-09-18', '2026-09-25'), {
      info: null,
      now: NOW_MS,
    });
    expect(old?.coverage).toEqual({ kind: 'window', from: '2026-09-18', to: '2026-09-25' });
    const ahead = inferredEntry(course(5, 'Seen'), inferred([friP1_2], '2026-10-02', '2026-11-13'), {
      info: null,
      now: NOW_MS,
    });
    expect(hits(ahead)).toEqual(fridays.slice(0, 4));
  });

  it('ends at a recent last session that lies outside every term, and follows a known syllabus term', () => {
    const summer = Date.parse('2026-08-05T03:00:00Z');
    const makeUp = inferredEntry(course(5, 'Seen'), inferred([friP1_2], '2026-06-05', '2026-07-31'), {
      info: null,
      now: summer,
    });
    expect(makeUp?.coverage).toMatchObject({ to: '2026-07-31' });
    const quarter = info('秋クォーター', [], { scheduleUnparsed: true });
    const q = inferredEntry(course(5, 'Seen'), inferred([friP1_2], '2026-10-02', '2026-10-09'), {
      info: quarter,
      now: NOW_MS,
    });
    expect(q?.coverage).toMatchObject({ kind: 'term', term: '秋クォーター' });
    expect(hits(q)).toEqual(['2026-10-16', '2026-11-13']); // 秋クォーター ends in late November
  });

  it('runs to the end of the term when the last session is from the past two weeks (made week by week)', () => {
    const recent = inferred([friP1_2], '2026-10-02', '2026-10-09');
    expect(hits(inferredEntry(course(5, 'Seen'), recent, { info: null, now: NOW_MS }))).toEqual(fridays.slice(0, 4)); // term ends 2027-02-02
    // the Moodle end of the course cuts it short
    const ends = course(5, 'Seen', { end: '2026-12-18T23:59:00+09:00' });
    expect(hits(inferredEntry(ends, recent, { info: null, now: NOW_MS }))).toEqual([
      '2026-10-16',
      '2026-11-13',
      '2026-12-18',
    ]);
  });

  it('counts 14 days back as recent and 15 as old', () => {
    const on20th = Date.parse('2026-10-20T03:00:00Z');
    const sessions = (lastDate: string) => inferred([friP1_2], '2026-10-02', lastDate);
    const at = (lastDate: string) => inferredEntry(course(5, 'Seen'), sessions(lastDate), { info: null, now: on20th });
    expect(at('2026-10-06')?.coverage).toMatchObject({ to: '2027-02-02' });
    expect(at('2026-10-05')?.coverage).toMatchObject({ to: '2026-10-05' });
  });
});
