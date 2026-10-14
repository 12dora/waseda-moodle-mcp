import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import type { SyllabusInfo, SyllabusSlot } from '../../src/core/services/syllabus';
import { classesOn, getTimetable, type TimetableEntry } from '../../src/core/services/timetable';
import { ACADEMIC_CALENDAR, type AcademicCalendar } from '../../src/core/services/timetable/calendar';
import { slotClock } from '../../src/core/services/timetable/periods';
import { makeFakeContext } from '../helpers/fake-context';

const NOW = new Date('2026-10-14T03:00:00Z'); // Wed 2026-10-14 12:00 JST
const TIMELINE = 'core_course_get_enrolled_courses_by_timeline_classification';
const ENROL = 'core_enrol_get_users_courses';
const EVENTS = 'core_calendar_get_action_events_by_timesort';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
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
  ...extra,
});

const entry = (id: number, name: string, i: SyllabusInfo): TimetableEntry => ({
  course: { id, name, url: `https://moodle.example.edu/course/view.php?id=${id}` },
  info: i,
});

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
    expect(day.note).toBe('Classes are held: スポーツの日');
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
    expect(day.note).toBe(`No classes: ${why}`);
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
    expect(classesOn('2026-12-23', [wed]).note).toBe('No classes: winter break');
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
    expect(day.note).toBe('No classes: outside the class period (term break)');
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
    expect(day.note).toBe('Follows the Mon schedule (振替)');
  });

  it('other dates keep their own weekday', () => {
    expect(names('2026-10-19', [mon, tue], calendar)).toEqual(['Monday course']);
    expect(names('2026-10-27', [mon, tue], calendar)).toEqual(['Tuesday course']);
  });
});

describe('classesOn: other academic years', () => {
  it('applies the month rules without holiday knowledge', () => {
    const mon = entry(1, 'Mon', info('秋クォーター', [slot(1, 1)]));
    expect(names('2027-10-04', [mon])).toEqual(['Mon']);
    expect(names('2027-11-29', [mon])).toEqual([]);
    expect(classesOn('2027-10-11', [mon]).note).toBeNull(); // スポーツの日 unknown: treated as a class day
  });
});

// ------------------------------------------------------------------ getTimetable

const ID_A = '2026570010006202'; // WBS night course
const ID_B = '2026160000000601'; // commerce
const ID_C = '2026160000000702'; // on-demand
const ID_D = '2026160000000803'; // intensive
const ID_E = '2026160000000904'; // no syllabus

const RAW = (id: number, idnumber: string, name: string) => ({ id, fullname: name, shortname: `C${id}`, idnumber });

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
    expect(res.days[0]).toMatchObject({ date: '2026-10-14', weekday: 3, note: null });
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
      },
    ]);
    expect(res.onDemand.map((c) => [c.courseId, c.kind, c.term])).toEqual([
      [3, 'on-demand', '秋学期'],
      [4, 'no-fixed-time', '集中'],
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
    expect(res.days.map((d) => [d.date, d.classes.map((c) => c.courseId), d.note])).toEqual([
      ['2026-11-02', [], null],
      ['2026-11-03', [], 'Classes are held: 文化の日'],
      ['2026-11-04', [2], null],
      ['2026-11-05', [], 'No classes: 臨時の休業日'],
      ['2026-11-06', [], 'No classes: 臨時の休業日'],
      ['2026-11-07', [], 'No classes: 早稲田祭'],
      ['2026-11-08', [], 'No classes: 早稲田祭'],
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

  it('14 days make at most the normal 3 syllabus fetches, shared with the course scope', async () => {
    const { t } = setup();
    const page = (cell: string) =>
      `<html><body><table><tr><th scope="row">学期曜日時限</th><td>${cell}</td></tr></table></body></html>`;
    const fetchFn = vi.fn(async () => new Response(page('秋学期&nbsp;&nbsp;月１時限')));
    vi.stubGlobal('fetch', fetchFn);
    const res = await getTimetable(t.ctx, { date: '2026-10-12', days: 14 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(res.days).toHaveLength(14);
    expect(res.days.filter((d) => d.classes.length > 0).map((d) => d.date)).toEqual(['2026-10-12', '2026-10-19']);
    expect(res.unknown.map((c) => c.courseId)).toEqual([4, 5]); // not fetched yet: shown as time unknown, next call catches up
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
    expect(res.unknown.map((c) => c.courseId)).toEqual([1, 3, 4, 5]);
  });

  it('rejects a bad date and a bad number of days', async () => {
    const { t } = setup();
    for (const date of ['2026-02-30', '10/14', 'yesterday', '2026-1-1']) {
      await expect(getTimetable(t.ctx, { date })).rejects.toBeInstanceOf(InvalidInput);
    }
    for (const days of [0, 15, 1.5, -1]) {
      await expect(getTimetable(t.ctx, { days })).rejects.toBeInstanceOf(InvalidInput);
    }
  });
});
