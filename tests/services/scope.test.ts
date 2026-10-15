import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceeded, InvalidInput, MoodleError, MoodleUnavailable } from '../../src/core/errors';
import { classifyCourse, mapCourse, resolveScope, setMyCourses } from '../../src/core/services/scope';
import { lookupTerms, type SyllabusInfo } from '../../src/core/services/syllabus';
import { makeFakeContext } from '../helpers/fake-context';

vi.mock('../../src/core/services/syllabus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/services/syllabus')>()),
  lookupTerms: vi.fn(async () => new Map()),
}));

const TIMELINE = 'core_course_get_enrolled_courses_by_timeline_classification';
const ENROL = 'core_enrol_get_users_courses';
const EVENTS = 'core_calendar_get_action_events_by_timesort';
const NOW = new Date('2026-10-14T03:00:00Z'); // 2026-10-14 12:00 JST
const NOW_SEC = NOW.getTime() / 1000;
const DAY = 86_400;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.mocked(lookupTerms).mockReset().mockResolvedValue(new Map());
});
afterEach(() => {
  vi.useRealTimers();
});

const raw = (id: number, idnumber: string) => ({ id, fullname: `Course ${id}`, shortname: `C${id}`, idnumber });
const TIMELINE_COURSES = {
  courses: [
    raw(1, '2026570010006202'), // class, accessed yesterday
    raw(2, '2026920015500116'), // class, accessed 40 days ago
    raw(3, '2020ZZT900001408'), // other, accessed yesterday
    raw(4, '2026570010009999'), // class, never accessed
  ],
};
const ENROLLED = [
  { id: 1, idnumber: '2026570010006202', lastaccess: NOW_SEC - DAY },
  { id: 2, lastaccess: NOW_SEC - 40 * DAY },
  { id: 3, lastaccess: NOW_SEC - DAY },
  { id: 4, lastaccess: 0 },
];
const eventsOf = (...courseIds: number[]) => ({ events: courseIds.map((id) => ({ id, course: { id } })) });
const responses = (events: unknown = eventsOf()) => ({
  [TIMELINE]: TIMELINE_COURSES,
  [ENROL]: ENROLLED,
  [EVENTS]: events,
});

describe('classifyCourse / mapCourse', () => {
  it('treats idnumbers containing ZZ as non-class courses', () => {
    expect(classifyCourse('2026570010006202')).toBe('class');
    expect(classifyCourse('2020ZZT900001408')).toBe('other');
    expect(classifyCourse('')).toBe('class');
    expect(classifyCourse(null)).toBe('class');
    expect(classifyCourse(undefined)).toBe('class');
  });

  it('mapCourse decodes names, builds a fallback url, clamps progress and starts with neutral flags', () => {
    const c = mapCourse(
      { id: 7, fullname: 'A &amp; B', progress: 150, hasprogress: true, idnumber: '2020ZZ1' },
      'https://m.example',
    );
    expect(c).toEqual({
      id: 7,
      name: 'A & B',
      shortName: '',
      category: null,
      url: 'https://m.example/course/view.php?id=7',
      start: null,
      end: null,
      progress: 100,
      kind: 'other',
      mine: false,
      suggested: false,
      term: null,
      lastAccess: null,
    });
  });
});

describe('resolveScope (automatic suggestion)', () => {
  it('suggests class courses accessed within 21 days and uses them as the scope', async () => {
    const { ctx, api } = makeFakeContext({ responses: responses() });
    const scope = await resolveScope(ctx);
    expect(scope.mode).toBe('auto');
    expect([...scope.mine]).toEqual([1]);
    expect(scope.courses.map((c) => [c.id, c.kind, c.suggested, c.mine])).toEqual([
      [1, 'class', true, true],
      [2, 'class', false, false],
      [3, 'other', false, false],
      [4, 'class', false, false],
    ]);
    expect(scope.courses[0]).toMatchObject({ lastAccess: '2026-10-13T12:00:00+09:00', term: null });
    expect(scope.courses[3]?.lastAccess).toBeNull();
    expect(api.calls).toEqual([
      { fn: TIMELINE, params: { classification: 'allincludinghidden', limit: 0 } },
      { fn: ENROL, params: { userid: 1001, returnusercount: 0 } },
      {
        fn: EVENTS,
        params: { timesortfrom: NOW_SEC, timesortto: NOW_SEC + 30 * DAY, limitnum: 50, limittononsuspendedevents: 1 },
      },
    ]);
  });

  it('is memoised per context', async () => {
    const { ctx, api } = makeFakeContext({ responses: responses() });
    const [a, b] = await Promise.all([resolveScope(ctx), resolveScope(ctx)]);
    expect(a).toBe(b);
    expect(await resolveScope(ctx)).toBe(a);
    expect(api.calls).toHaveLength(3);
    const other = makeFakeContext({ responses: responses() });
    expect(await resolveScope(other.ctx)).not.toBe(a);
  });

  it('adds courses with a calendar event in the next 30 days (one shared call)', async () => {
    const { ctx, api } = makeFakeContext({ responses: responses(eventsOf(2, 3, 3)) }); // 3 is non-class: never suggested
    const scope = await resolveScope(ctx);
    expect([...scope.mine].sort()).toEqual([1, 2]);
    expect(api.count(EVENTS)).toBe(1);
  });

  it('asks for the events once per request, also when the scope is recomputed after setMyCourses', async () => {
    const t = makeFakeContext({ responses: responses(eventsOf(4)) });
    expect([...(await resolveScope(t.ctx)).mine].sort()).toEqual([1, 4]);
    await setMyCourses(t.ctx, [2]);
    expect([...(await resolveScope(t.ctx)).mine]).toEqual([2]);
    expect(t.api.count(EVENTS)).toBe(1);
  });

  it('does not ask for events when terms and lastaccess already decide every class course', async () => {
    vi.mocked(lookupTerms).mockResolvedValue(
      new Map([
        [2, info('秋クォーター')],
        [4, info('冬クォーター')],
      ]),
    );
    const { ctx, api } = makeFakeContext({ responses: responses() });
    await resolveScope(ctx);
    expect(api.count(EVENTS)).toBe(0);
  });

  it('calendarSignal: false (scheduled sweep) skips the events call', async () => {
    const { ctx, api } = makeFakeContext({ responses: responses(eventsOf(2)) });
    const scope = await resolveScope(ctx, { calendarSignal: false });
    expect([...scope.mine]).toEqual([1]);
    expect(api.count(EVENTS)).toBe(0);
  });

  it('survives a refused events call', async () => {
    const { ctx } = makeFakeContext({ responses: responses(new MoodleError('denied', 'accessexception')) });
    expect([...(await resolveScope(ctx)).mine]).toEqual([1]);
  });

  it.each([
    ['MoodleUnavailable', new MoodleUnavailable()],
    ['BudgetExceeded', new BudgetExceeded()],
  ])('treats %s from the optional events call as no signal', async (_name, error) => {
    const { ctx } = makeFakeContext({ responses: responses(error) });
    expect([...(await resolveScope(ctx)).mine]).toEqual([1]);
  });

  describe('events paging', () => {
    const page = (ids: number[], lastid?: number) => ({
      events: ids.map((id, i) => ({ id: i + 1, course: { id } })),
      lastid,
    });
    const filler = (n: number, first: number) => Array.from({ length: n }, (_, i) => first + 100 + i);
    const secondPage = (params: Record<string, unknown>) => params.aftereventid !== undefined;

    it('asks for a second page after a full first one, and not for a third', async () => {
      const full = (first: number) => page([first, ...filler(49, first)], 500);
      const { ctx, api } = makeFakeContext({
        responses: responses((params: Record<string, unknown>) => full(secondPage(params) ? 4 : 2)),
      });
      expect([...(await resolveScope(ctx)).mine].sort()).toEqual([1, 2, 4]);
      expect(api.count(EVENTS)).toBe(2);
      expect(api.calls.filter((c) => c.fn === EVENTS).map((c) => c.params.aftereventid)).toEqual([undefined, 500]);
    });

    it('does not ask again after a short page', async () => {
      const { ctx, api } = makeFakeContext({ responses: responses(page([4], 9)) });
      expect([...(await resolveScope(ctx)).mine].sort()).toEqual([1, 4]);
      expect(api.count(EVENTS)).toBe(1);
    });

    it('keeps the first page when the second one fails', async () => {
      const second = new MoodleUnavailable();
      const { ctx } = makeFakeContext({
        responses: responses((params: Record<string, unknown>) =>
          secondPage(params) ? second : page([4, ...filler(49, 4)], 500),
        ),
      });
      expect([...(await resolveScope(ctx)).mine].sort()).toEqual([1, 4]);
    });
  });

  it('still works when lastaccess is unavailable', async () => {
    const { ctx } = makeFakeContext({
      responses: { [TIMELINE]: TIMELINE_COURSES, [ENROL]: new MoodleError('denied', 'accessexception') },
    });
    const scope = await resolveScope(ctx);
    expect(scope.mine.size).toBe(0);
    expect(scope.courses.map((c) => c.lastAccess)).toEqual([null, null, null, null]);
  });

  it('propagates failures of the course list itself', async () => {
    const { ctx } = makeFakeContext({ responses: { [TIMELINE]: new MoodleError('boom'), [ENROL]: [] } });
    await expect(resolveScope(ctx)).rejects.toBeInstanceOf(MoodleError);
  });
});

const info = (term: string | null): SyllabusInfo => ({
  pKey: 'k',
  year: 2026,
  term,
  dayPeriod: null,
  instructors: [],
});

describe('resolveScope (syllabus terms)', () => {
  it('fills Course.term and passes idnumbers to the lookup', async () => {
    vi.mocked(lookupTerms).mockResolvedValue(new Map([[1, info('秋クォーター')]]));
    const { ctx } = makeFakeContext({ responses: responses() });
    const scope = await resolveScope(ctx);
    expect(scope.courses.map((c) => c.term)).toEqual(['秋クォーター', null, null, null]);
    const [lookupCtx, lookups, opts] = vi.mocked(lookupTerms).mock.calls[0] ?? [];
    expect(lookupCtx).toBe(ctx);
    expect(lookups).toEqual([
      { id: 1, idnumber: '2026570010006202' },
      { id: 2, idnumber: '2026920015500116' },
      { id: 3, idnumber: '2020ZZT900001408' },
      { id: 4, idnumber: '2026570010009999' },
    ]);
    expect(opts).toEqual({ syllabusLookup: true });
    expect(vi.mocked(lookupTerms)).toHaveBeenCalledTimes(1);
  });

  it('suggests a current-term course without any access or event signal', async () => {
    vi.mocked(lookupTerms).mockResolvedValue(
      new Map([
        [4, info('秋クォーター')],
        [2, info('通年')],
      ]),
    );
    const { ctx } = makeFakeContext({ responses: responses() });
    expect([...(await resolveScope(ctx)).mine].sort()).toEqual([1, 2, 4]);
  });

  it('never suggests a known non-current term, even with recent access or an upcoming event', async () => {
    vi.mocked(lookupTerms).mockResolvedValue(
      new Map([
        [1, info('冬クォーター')],
        [4, info('春学期')],
      ]),
    );
    const { ctx } = makeFakeContext({ responses: responses(eventsOf(4)) });
    const scope = await resolveScope(ctx);
    expect(scope.mine.size).toBe(0);
    expect(scope.courses[0]).toMatchObject({ term: '冬クォーター', suggested: false, lastAccess: expect.any(String) });
  });

  it('treats a missing term and 集中 as unknown: the access / event rule decides', async () => {
    vi.mocked(lookupTerms).mockResolvedValue(
      new Map([
        [1, info('集中')],
        [2, info(null)],
      ]),
    );
    const { ctx } = makeFakeContext({ responses: responses(eventsOf(2)) });
    expect([...(await resolveScope(ctx)).mine].sort()).toEqual([1, 2]);
  });

  it('looks terms up once per request even when the scope is recomputed', async () => {
    const t = makeFakeContext({ responses: responses() });
    await resolveScope(t.ctx);
    await setMyCourses(t.ctx, [1]);
    await resolveScope(t.ctx);
    expect(vi.mocked(lookupTerms)).toHaveBeenCalledTimes(1);
  });

  it('only a term of the current academic year counts (idnumber year; January-March belong to the previous year)', async () => {
    const t = {
      [TIMELINE]: { courses: [raw(1, '2025570010006202'), raw(2, '2025570010006203'), raw(3, '2026570010006204')] },
      [ENROL]: [],
      [EVENTS]: eventsOf(),
    };
    vi.mocked(lookupTerms).mockResolvedValue(
      new Map([
        [1, info('秋クォーター')], // last year's 秋Q, still enrolled
        [2, info('通年')], // last year's 通年
        [3, info('秋クォーター')],
      ]),
    );
    const { ctx } = makeFakeContext({ responses: t });
    expect([...(await resolveScope(ctx)).mine]).toEqual([3]);

    // 2027-02-10 is still academic year 2026: the 2026 冬クォーター course is current, the 2027 one is not (yet)
    vi.setSystemTime(new Date('2027-02-10T03:00:00Z'));
    vi.mocked(lookupTerms).mockResolvedValue(
      new Map([
        [1, info('冬クォーター')],
        [3, info('冬クォーター')],
      ]),
    );
    const winter = makeFakeContext({
      responses: { ...t, [TIMELINE]: { courses: [raw(1, '2027570010006202'), raw(3, '2026570010006204')] } },
    });
    expect([...(await resolveScope(winter.ctx)).mine]).toEqual([3]);
  });

  it('a term is current from 14 days before it starts (pre-course quiz before the 冬クォーター)', async () => {
    vi.mocked(lookupTerms).mockResolvedValue(new Map([[1, info('冬クォーター')]]));
    const early = makeFakeContext({ responses: responses() });
    expect([...(await resolveScope(early.ctx)).mine]).toEqual([]); // 2026-10-14: 5+ weeks away
    vi.setSystemTime(new Date('2026-11-10T03:00:00Z')); // 12 days before 11/22
    const soon = makeFakeContext({ responses: responses() });
    expect([...(await resolveScope(soon.ctx)).mine]).toEqual([1]);
  });

  it('a term stays current for 14 days after it ends (final reports are swept after the last class)', async () => {
    vi.mocked(lookupTerms).mockResolvedValue(new Map([[1, info('秋クォーター')]]));
    vi.setSystemTime(new Date('2026-11-25T03:00:00Z')); // 秋Q ended 11/21, 冬Q has begun
    const grace = makeFakeContext({ responses: { ...responses(), [ENROL]: [] } });
    expect([...(await resolveScope(grace.ctx)).mine]).toEqual([1]);
    vi.setSystemTime(new Date('2026-12-07T03:00:00Z')); // more than 14 days after
    const over = makeFakeContext({ responses: { ...responses(), [ENROL]: [] } });
    expect([...(await resolveScope(over.ctx)).mine]).toEqual([]);
  });

  it('forwards the syllabus kill switch', async () => {
    const { ctx } = makeFakeContext({ responses: responses() });
    await resolveScope(ctx, { syllabusLookup: false });
    expect(vi.mocked(lookupTerms).mock.calls[0]?.[2]).toEqual({ syllabusLookup: false });
  });
});

describe('resolveScope (confirmed selection)', () => {
  it('uses myCourseIds as given, even for non-class courses, keeping suggestions visible', async () => {
    const { ctx } = makeFakeContext({ responses: responses(), user: { settings: { myCourseIds: [3, 4, 99] } } });
    const scope = await resolveScope(ctx);
    expect(scope.mode).toBe('mine');
    expect([...scope.mine]).toEqual([3, 4]); // 99 is not enrolled any more
    expect(scope.courses.map((c) => [c.id, c.mine, c.suggested])).toEqual([
      [1, false, true],
      [2, false, false],
      [3, true, false],
      [4, true, false],
    ]);
  });

  it('an empty confirmed list is a valid (empty) scope', async () => {
    const { ctx } = makeFakeContext({ responses: responses(), user: { settings: { myCourseIds: [] } } });
    const scope = await resolveScope(ctx);
    expect(scope.mode).toBe('mine');
    expect(scope.mine.size).toBe(0);
  });
});

describe('setMyCourses', () => {
  it('validates enrolment, persists, audits and refreshes the scope', async () => {
    const t = makeFakeContext({ responses: responses() });
    const settings = await setMyCourses(t.ctx, [2, 4, 2]);
    expect(settings.myCourseIds).toEqual([2, 4]);
    expect(t.state.users.get(t.ctx.user.id)?.settings.myCourseIds).toEqual([2, 4]);
    expect(t.ctx.user.settings.myCourseIds).toEqual([2, 4]);
    expect(t.state.audit).toMatchObject([{ userId: 1, action: 'settings:my_courses', detail: { count: 2 } }]);

    const scope = await resolveScope(t.ctx);
    expect(scope.mode).toBe('mine');
    expect([...scope.mine]).toEqual([2, 4]);
  });

  it('keeps the other settings', async () => {
    const t = makeFakeContext({ responses: responses(), user: { settings: { writeMode: 'console', uiLang: 'ja' } } });
    expect(await setMyCourses(t.ctx, [1])).toEqual({
      writeMode: 'console',
      uiLang: 'ja',
      myCourseIds: [1],
      scheduleOverrides: {},
    });
  });

  it('rejects ids the user is not enrolled in and malformed ids, storing nothing', async () => {
    const t = makeFakeContext({ responses: responses() });
    await expect(setMyCourses(t.ctx, [1, 99])).rejects.toThrow(/99/);
    await expect(setMyCourses(t.ctx, [1, 99])).rejects.toBeInstanceOf(InvalidInput);
    await expect(setMyCourses(t.ctx, [0])).rejects.toBeInstanceOf(InvalidInput);
    await expect(setMyCourses(t.ctx, [1.5])).rejects.toBeInstanceOf(InvalidInput);
    await expect(setMyCourses(t.ctx, [])).rejects.toThrow('Select at least one course, or reset to the suggestion.');
    expect(t.ctx.user.settings.myCourseIds).toBeNull();
    expect(t.state.audit).toHaveLength(0);
  });

  it('null returns to the automatic suggestion', async () => {
    const t = makeFakeContext({ responses: responses(), user: { settings: { myCourseIds: [2] } } });
    expect((await setMyCourses(t.ctx, null)).myCourseIds).toBeNull();
    expect(t.state.audit).toMatchObject([{ detail: { count: null } }]);
    const scope = await resolveScope(t.ctx);
    expect(scope.mode).toBe('auto');
    expect([...scope.mine]).toEqual([1]);
  });
});
