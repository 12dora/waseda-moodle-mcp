import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoodleError, NeedsReconnect, NotFound } from '../../src/core/errors';
import { getCourseOverview, getSyllabusSummary } from '../../src/core/services/course-overview';
import { getDueItems } from '../../src/core/services/due';
import { countDue } from '../../src/core/services/due-groups';
import type { CourseSnapshot } from '../../src/core/services/sweep/snapshot';
import { DETAIL_URL, type SyllabusInfo, syllabusPKey } from '../../src/core/services/syllabus';
import { parseSyllabusPage } from '../../src/core/services/syllabus-page';
import type { DueItem } from '../../src/core/types';
import { JA_PAGE } from '../fixtures/syllabus';
import { makeFakeContext } from '../helpers/fake-context';

vi.mock('../../src/core/services/due', () => ({ getDueItems: vi.fn() }));

const NOW = new Date('2026-10-14T03:00:00Z');
const NOW_MS = NOW.getTime();
const DAY_MS = 86_400_000;
const ID1 = '2026160000000616';
const ID2 = '2026160000000716';
const ZZ = '2020ZZT900001408';
const PKEY1 = syllabusPKey(ID1) ?? '';
const TIMELINE = 'core_course_get_enrolled_courses_by_timeline_classification';
const ENROL = 'core_enrol_get_users_courses';
const EVENTS = 'core_calendar_get_action_events_by_timesort';
const ATTEND = 'core_calendar_get_calendar_events';
const CONTENTS = 'core_course_get_contents';
const UPDATES = 'core_course_get_updates_since';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.mocked(getDueItems).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const raw = (id: number, idnumber: string, name: string) => ({
  id,
  fullname: name,
  shortname: `C${id}`,
  idnumber,
  viewurl: `https://moodle.example.edu/course/view.php?id=${id}`,
});

function due(over: Partial<DueItem>): DueItem {
  return {
    kind: 'assign',
    courseId: 1,
    courseName: 'Valuation',
    cmid: 1,
    name: 'x',
    opensAt: null,
    dueAt: '2026-10-20T23:59:00+09:00',
    midnightDue: false,
    overdue: false,
    closed: false,
    notOpenYet: false,
    url: 'https://moodle.example.edu/mod/assign/view.php?id=1',
    action: null,
    source: 'calendar',
    evidence: null,
    sourceUrl: null,
    isNew: false,
    submission: null,
    ...over,
  };
}

const sub = (status: NonNullable<DueItem['submission']>['status']): DueItem['submission'] => ({
  status,
  canContinue: false,
  submittedAt: null,
  graded: false,
  note: null,
});

function boom(label: string) {
  return () => {
    throw new Error(label);
  };
}

function setup(myCourseIds: number[] | null = [2, 1]) {
  const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  const t = makeFakeContext({
    user: { lang: 'ja', settings: { myCourseIds } },
    responses: {
      [TIMELINE]: { courses: [raw(1, ID1, 'Valuation'), raw(2, ID2, 'Japanese'), raw(3, ZZ, 'Library')] },
      [ENROL]: [],
      [EVENTS]: { events: [] },
      [ATTEND]: boom('live attendance'),
      [CONTENTS]: boom('snapshot refresh'),
      [UPDATES]: boom('snapshot refresh'),
    },
  });
  return { t, fetchMock };
}

const SLOT = { weekday: 2, periodFrom: 3, periodTo: 4, night: false, classroom: '11-123', campus: '早稲田' };

function termInfo(over: Partial<SyllabusInfo> = {}): SyllabusInfo {
  return {
    pKey: PKEY1,
    year: 2026,
    term: '秋クォーター',
    dayPeriod: '火３-４',
    instructors: [],
    slots: [SLOT],
    onDemand: false,
    scheduleUnparsed: false,
    ...over,
  };
}

function seedTerm(t: ReturnType<typeof setup>['t'], idnumber: string, info: SyllabusInfo | null) {
  t.state.syllabusCache.set(idnumber, { json: JSON.stringify(info), fetchedAt: NOW_MS });
}

function seedDetails(t: ReturnType<typeof setup>['t']) {
  const page = parseSyllabusPage(JA_PAGE, 'ja');
  t.state.syllabusCache.set(`d:${ID1}`, { json: JSON.stringify({ v: 1, page }), fetchedAt: NOW_MS });
}

function emptyDue() {
  vi.mocked(getDueItems).mockResolvedValue({ items: [] } as never);
}

describe('getCourseOverview', () => {
  it('returns scope-order courses with counts, cache-only syllabus and no live fan-out', async () => {
    const { t, fetchMock } = setup([2, 1]);
    seedTerm(t, ID1, termInfo());
    seedTerm(t, ID2, null);
    seedDetails(t);
    const valuation = [
      due({ name: 'late', overdue: true }),
      due({ name: 'todo', cmid: 2 }),
      due({ name: 'draft', cmid: 3, submission: sub('draft') }),
      due({ name: 'done', cmid: 4, submission: sub('submitted') }),
    ];
    const jp = due({ name: 'jp', courseId: 2, courseName: 'Japanese', cmid: 5 });
    vi.mocked(getDueItems).mockResolvedValue({ items: [...valuation, jp] } as never);

    const r = await getCourseOverview(t.ctx);
    expect(vi.mocked(getDueItems).mock.calls[0]?.[1]).toEqual({
      daysAhead: 60,
      overdueDays: 30,
      sweep: 'cached',
      maxSubmissionChecks: 150,
    });
    expect(r.dueError).toBe(false);
    expect(r.scopeMode).toBe('mine');
    expect(r.generatedAt).toMatch(/\+09:00$/);
    expect(r.courses.map((c) => c.id)).toEqual([1, 2]);
    expect(r.courses[0]).toMatchObject({
      id: 1,
      name: 'Valuation',
      term: '秋クォーター',
      kind: 'class',
      syllabusUrl: `${DETAIL_URL}?pKey=${PKEY1}&pLng=jp`,
      syllabusStatus: 'found',
      gradingText: null,
      schedule: {
        listing: null,
        alsoInClass: true,
        source: 'syllabus',
        slots: [
          {
            weekday: 2,
            periodFrom: 3,
            periodTo: 4,
            start: '13:10',
            end: '16:45',
            classroom: '11-123',
            campus: '早稲田',
          },
        ],
      },
    });
    expect(r.courses[0]?.grading).toEqual([
      { method: '試験', weight: 60, criteria: '第14回に実施する。\n持ち込み不可。' },
      { method: '平常点評価', weight: 40, criteria: '毎回の小テスト。' },
    ]);
    expect(r.courses[0]?.items.map((i) => i.name)).toEqual(['late', 'todo', 'draft', 'done']);
    expect(r.courses[0]?.counts).toEqual(countDue(valuation));
    expect(r.courses[1]).toMatchObject({
      id: 2,
      syllabusUrl: null,
      syllabusStatus: 'unknown',
      grading: null,
      gradingText: null,
      schedule: { slots: [], listing: null, alsoInClass: false, source: null },
      counts: countDue([jp]),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.api.calls.map((c) => c.fn)).not.toContain(ATTEND);
    expect(t.api.calls.map((c) => c.fn)).not.toContain(CONTENTS);
    expect(t.api.calls.map((c) => c.fn)).not.toContain(UPDATES);
    expect(t.state.snapshotWrites).toEqual([]);
  });

  it('marks a cached "no page" as not-found so the console does not fetch it again', async () => {
    const { t } = setup([2, 1]);
    t.state.syllabusCache.set(`d:${ID2}`, { json: JSON.stringify({ v: 1, page: null }), fetchedAt: NOW_MS });
    emptyDue();
    const r = await getCourseOverview(t.ctx);
    expect(r.courses.find((c) => c.id === 2)).toMatchObject({ syllabusStatus: 'not-found', grading: null });
    expect(r.courses.find((c) => c.id === 1)).toMatchObject({ syllabusStatus: 'unknown' });
  });

  it('uses a stored inferred schedule and a user override, converting night periods', async () => {
    const t = makeFakeContext({
      user: {
        lang: 'ja',
        settings: {
          myCourseIds: [1, 2],
          scheduleOverrides: {
            '1': {
              mode: 'slots',
              slots: [{ weekday: 1, periodFrom: 6, periodTo: 6, night: true, classroom: '51' }],
              alsoOnDemand: false,
            },
          },
        },
      },
      responses: {
        [TIMELINE]: { courses: [raw(1, ID1, 'Valuation'), raw(2, ID2, 'Japanese')] },
        [ENROL]: [],
        [EVENTS]: { events: [] },
        [ATTEND]: boom('live attendance'),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    seedTerm(t, ID1, termInfo());
    seedTerm(t, ID2, null);
    t.state.inferredSchedules.set('1:2', {
      slots: [{ weekday: 5, periodFrom: 1, periodTo: 2, night: false, classroom: '31-101' }],
      firstDate: '2026-10-02',
      lastDate: '2026-10-16',
      checkedAt: NOW_MS,
    });
    emptyDue();

    const r = await getCourseOverview(t.ctx);
    expect(r.courses[0]?.schedule).toMatchObject({
      source: 'user',
      slots: [{ weekday: 1, periodFrom: 6, periodTo: 6, start: '18:30', end: '20:10', classroom: '51' }],
    });
    expect(r.courses[1]?.schedule).toMatchObject({
      source: 'moodle',
      slots: [{ weekday: 5, periodFrom: 1, periodTo: 2, start: '08:50', end: '12:20', classroom: '31-101' }],
    });
    expect(t.api.calls.map((c) => c.fn)).not.toContain(ATTEND);
  });

  it('lists stored updates newest first, max 10 per course, and skips ones older than 14 days', async () => {
    const { t } = setup([1]);
    seedTerm(t, ID1, termInfo());
    emptyDue();
    const mods = Array.from({ length: 12 }, (_, i) => ({
      c: 200 + i,
      t: 'resource',
      n: `U${i}`,
      u: `https://moodle.example.edu/mod/resource/view.php?id=${200 + i}`,
      s: NOW_MS - i * 60_000,
    }));
    mods.push({
      c: 99,
      t: 'url',
      n: 'old',
      u: 'https://moodle.example.edu/mod/url/view.php?id=99',
      s: NOW_MS - 15 * DAY_MS,
    });
    const snap: CourseSnapshot = { v: 1, s: [{ i: 1, k: 1, n: 'W', m: mods }], x: [] };
    t.state.courseSnapshots.set('1:1', {
      userId: 1,
      courseId: 1,
      json: JSON.stringify(snap),
      fetchedAt: NOW_MS,
      checkedAt: NOW_MS,
    });

    const r = await getCourseOverview(t.ctx);
    expect(r.courses[0]?.updates.map((u) => u.cmid)).toEqual(Array.from({ length: 10 }, (_, i) => 200 + i));
    expect(r.courses[0]?.updates[0]?.change).toBe('new');
    expect(r.courses[0]?.updates.some((u) => u.cmid === 99)).toBe(false);
    expect(t.state.snapshotWrites).toEqual([]);
  });

  it('omits enrolled courses outside the selection', async () => {
    const { t } = setup([1]);
    seedTerm(t, ID1, termInfo());
    emptyDue();
    const r = await getCourseOverview(t.ctx);
    expect(r.courses.map((c) => c.id)).toEqual([1]);
  });

  it('keeps D1 course rows when the due list fails, and surfaces a reconnect', async () => {
    const { t } = setup([1]);
    seedTerm(t, ID1, termInfo());
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getDueItems).mockRejectedValue(new Error('timeout'));
    const timedOut = await getCourseOverview(t.ctx);
    expect(timedOut.dueError).toBe(true);
    expect(timedOut.courses).toHaveLength(1);
    expect(timedOut.courses[0]?.items).toEqual([]);
    expect(timedOut.courses[0]?.counts).toEqual({ overdue: 0, todo: 0, draft: 0, done: 0 });

    vi.mocked(getDueItems).mockRejectedValue(new MoodleError('calendar failed', 'invalidrecord'));
    const moodle = await getCourseOverview(t.ctx);
    expect(moodle.dueError).toBe(true);
    expect(moodle.courses.map((c) => c.id)).toEqual([1]);
    logged.mockRestore();

    vi.mocked(getDueItems).mockRejectedValue(new NeedsReconnect());
    await expect(getCourseOverview(t.ctx)).rejects.toBeInstanceOf(NeedsReconnect);
    vi.mocked(getDueItems).mockRejectedValue(new MoodleError('bad token', 'invalidtoken'));
    await expect(getCourseOverview(t.ctx)).rejects.toBeInstanceOf(MoodleError);
  });

  it('reads stored snapshots once for the due sweep and the updates', async () => {
    const { getDueItems: realGetDueItems } =
      await vi.importActual<typeof import('../../src/core/services/due')>('../../src/core/services/due');
    vi.mocked(getDueItems).mockImplementation(realGetDueItems);
    const { t } = setup([1]);
    seedTerm(t, ID1, termInfo());
    const spy = vi.spyOn(t.ctx.store, 'getCourseSnapshots');
    await getCourseOverview(t.ctx);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('getSyllabusSummary', () => {
  it('returns found grading from getSyllabusDetails and 404s a foreign course', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        calls.push(`${url.searchParams.get('pKey')}:${url.searchParams.get('pLng')}`);
        return new Response(JA_PAGE, { status: 200 });
      }),
    );
    const t = makeFakeContext({
      user: { lang: 'ja' },
      responses: {
        [TIMELINE]: { courses: [raw(1, ID1, 'Valuation'), raw(3, ZZ, 'Library')] },
        [ENROL]: [],
        [EVENTS]: { events: [] },
      },
    });
    const found = await getSyllabusSummary(t.ctx, 1);
    expect(found.status).toBe('found');
    expect(found.courseId).toBe(1);
    expect(found.grading).toHaveLength(2);
    expect(found.gradingText).toBeNull();
    expect(found.url).toContain('pLng=jp');
    expect(calls.length).toBeGreaterThan(0);

    const missing = await getSyllabusSummary(t.ctx, 3);
    expect(missing).toMatchObject({ courseId: 3, grading: null, status: 'not-found' });

    await expect(getSyllabusSummary(t.ctx, 99)).rejects.toBeInstanceOf(NotFound);
  });

  it('maps a failed public fetch to status error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    const t = makeFakeContext({
      user: { lang: 'ja' },
      responses: {
        [TIMELINE]: { courses: [raw(1, ID1, 'Valuation')] },
        [ENROL]: [],
        [EVENTS]: { events: [] },
      },
    });
    expect(await getSyllabusSummary(t.ctx, 1)).toMatchObject({ status: 'error', grading: null, courseId: 1 });
  });
});
