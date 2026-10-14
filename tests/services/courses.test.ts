import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, NotFound } from '../../src/core/errors';
import {
  getCourseOutline,
  listAllCourses,
  listCourses,
  mapCompleted,
  mapDates,
  mapSections,
  searchCourseContent,
} from '../../src/core/services/courses';
import { searchSnapshots } from '../../src/core/services/sweep';
import contentsFixture from '../fixtures/be2/course_contents.json';
import timeline from '../fixtures/be2/timeline_courses.json';
import { makeFakeContext } from '../helpers/fake-context';

vi.mock('../../src/core/services/sweep', () => ({
  searchSnapshots: vi.fn(async () => ({ hits: [], searchedCourses: 0, refreshed: 0, skipped: 0 })),
}));

const TIMELINE = 'core_course_get_enrolled_courses_by_timeline_classification';
const CONTENTS = 'core_course_get_contents';
const ENROL = 'core_enrol_get_users_courses';
const NOW = new Date('2026-10-14T03:00:00Z'); // 2026-10-14 12:00 JST
const NOW_SEC = NOW.getTime() / 1000;
const DAY = 86_400;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function courseContents(courseId: number): unknown {
  if (courseId === 101) return contentsFixture;
  const cmid = courseId * 100 + 1;
  return [
    {
      id: courseId * 10,
      name: 'Week 1',
      section: 1,
      uservisible: true,
      summary: '',
      modules: [
        {
          id: cmid,
          instance: 1,
          name: `Handout ${courseId}`,
          modname: 'resource',
          visible: 1,
          uservisible: true,
          url: `https://moodle.example.edu/mod/resource/view.php?id=${cmid}`,
          contents: [],
        },
      ],
    },
  ];
}

function responses() {
  return {
    [TIMELINE]: timeline,
    [CONTENTS]: (p: Record<string, unknown>) => courseContents(p.courseid as number),
  };
}

const ENROLLED = [
  { id: 101, lastaccess: NOW_SEC - DAY }, // recent
  { id: 102, lastaccess: NOW_SEC - 40 * DAY }, // stale
  { id: 103, lastaccess: 0 }, // never
];

describe('listCourses', () => {
  const EVENTS = 'core_calendar_get_action_events_by_timesort';
  const fakes = (events: unknown[] = []) =>
    makeFakeContext({ responses: { [TIMELINE]: timeline, [ENROL]: ENROLLED, [EVENTS]: { events } } });

  it('returns the suggested courses by default, mapped with scope fields', async () => {
    const { ctx, api } = fakes();
    const courses = await listCourses(ctx);
    expect(api.calls.map((c) => c.fn)).toEqual([TIMELINE, ENROL, EVENTS]);
    expect(api.calls[0]?.params).toEqual({ classification: 'allincludinghidden', limit: 0 });
    expect(api.calls[1]?.params).toEqual({ userid: 1001, returnusercount: 0 });
    expect(courses).toEqual([
      {
        id: 101,
        name: 'Introduction to Finance & Accounting',
        shortName: 'FIN101',
        category: 'Business & Commerce',
        url: 'https://moodle.example.edu/course/view.php?id=101',
        start: '2026-09-01T00:00:00+09:00',
        end: '2027-01-31T00:00:00+09:00',
        progress: 40,
        kind: 'class',
        mine: true,
        suggested: true,
        term: null,
        lastAccess: '2026-10-13T12:00:00+09:00',
      },
    ]);
  });

  it('suggests a course with a calendar event in the next 30 days, the same way get_due does', async () => {
    const courses = await listCourses(fakes([{ id: 1, course: { id: 103 } }]).ctx);
    expect(courses.map((c) => c.id)).toEqual([101, 103]);
  });

  it('lists every enrolled course with scope: all', async () => {
    const courses = await listCourses(fakes().ctx, { scope: 'all' });
    expect(courses.map((c) => [c.id, c.mine, c.suggested])).toEqual([
      [101, true, true],
      [102, false, false],
      [103, false, false],
      [104, false, false],
    ]);
    expect(courses[1]?.progress).toBeNull(); // hasprogress=false
  });

  it('follows the confirmed selection once myCourseIds is set', async () => {
    const { ctx } = makeFakeContext({
      responses: { [TIMELINE]: timeline, [ENROL]: ENROLLED },
      user: { settings: { myCourseIds: [102, 104] } },
    });
    expect((await listCourses(ctx)).map((c) => c.id)).toEqual([102, 104]);
    expect((await listCourses(ctx, { scope: 'all' })).filter((c) => c.suggested).map((c) => c.id)).toEqual([101]);
  });

  it('listAllCourses is one light call and flags only confirmed selections', async () => {
    const { ctx, api } = makeFakeContext({
      responses: { [TIMELINE]: timeline.courses },
      user: { settings: { myCourseIds: [103] } },
    });
    const all = await listAllCourses(ctx);
    expect(api.calls.map((c) => c.fn)).toEqual([TIMELINE]);
    expect(all.map((c) => [c.id, c.mine])).toEqual([
      [101, false],
      [102, false],
      [103, true],
      [104, false],
    ]);
  });
});

describe('mappers', () => {
  it('mapDates maps known dataids, label fallbacks and skips unset timestamps', () => {
    const ts = 1792076340; // 2026-10-15 23:59 JST
    expect(
      mapDates([
        { label: '期限:', timestamp: ts, dataid: 'duedate' },
        { label: 'x', timestamp: ts, dataid: 'customthing' },
        { label: 'Due date', timestamp: ts },
        { label: 'Closes', timestamp: 0, dataid: 'timeclose' },
      ]),
    ).toEqual({
      due: '2026-10-15T23:59:00+09:00',
      customthing: '2026-10-15T23:59:00+09:00',
      due3: '2026-10-15T23:59:00+09:00',
    });
    expect(mapDates(undefined)).toEqual({});
  });

  it('mapCompleted distinguishes untracked, incomplete and complete', () => {
    expect(mapCompleted({})).toBeNull();
    expect(mapCompleted({ completion: 0, completiondata: { state: 0, hascompletion: false } })).toBeNull();
    expect(mapCompleted({ completion: 1, completiondata: { state: 0, hascompletion: true } })).toBe(false);
    expect(mapCompleted({ completion: 2, completiondata: { state: 1, hascompletion: true } })).toBe(true);
    expect(mapCompleted({ completion: 2, completiondata: { state: 2, hascompletion: true } })).toBe(true);
    expect(mapCompleted({ completion: 2, completiondata: { state: 3, hascompletion: true } })).toBe(false);
  });

  it('mapSections skips invisible sections and modules, names section 0 "General"', () => {
    const sections = mapSections(contentsFixture);
    expect(sections.map((s) => s.number)).toEqual([0, 1, 2]);
    expect(sections[0]?.name).toBe('General');
    expect(sections[1]?.modules.map((m) => m.cmid)).toEqual([5102, 5001, 5104]);
  });

  it('mapSections can skip the summary conversion', () => {
    expect(mapSections(contentsFixture)[1]?.summary).toContain('Intro week');
    expect(mapSections(contentsFixture, { summaries: false })[1]?.summary).toBe('');
  });
});

describe('getCourseOutline', () => {
  it('maps sections, modules, dates, completion and files', async () => {
    const { ctx, api } = makeFakeContext({ responses: responses() });
    const outline = await getCourseOutline(ctx, 101);

    expect(api.calls.find((c) => c.fn === CONTENTS)?.params).toEqual({ courseid: 101 });
    expect(api.calls.find((c) => c.fn === TIMELINE)?.params).toEqual({
      classification: 'allincludinghidden',
      limit: 0,
    });
    expect(outline.course.id).toBe(101);
    expect(outline.course.name).toBe('Introduction to Finance & Accounting');
    expect(outline.sections.map((s) => s.number)).toEqual([0, 1, 2]);

    const [general, week1, week2] = outline.sections;
    expect(week1?.name).toBe('Week 1 & Orientation');
    expect(week1?.summary).toContain('Intro week');
    expect(general?.modules[0]).toMatchObject({ modname: 'forum', completed: null, files: [], dates: {} });

    const [slides, report, label] = week1?.modules ?? [];
    expect(slides).toMatchObject({
      cmid: 5102,
      name: 'Lecture 1 Slides',
      modname: 'resource',
      completed: true,
      visible: true,
    });
    expect(slides?.files).toEqual([
      {
        name: 'Lecture1_Slides.pdf',
        size: 123456,
        mime: 'application/pdf',
        url: 'https://moodle.example.edu/webservice/pluginfile.php/10/mod_resource/content/1/Lecture1_Slides.pdf?forcedownload=1',
        modified: '2026-10-01T10:00:00+09:00',
      },
    ]);
    expect(slides?.files[0]?.url).not.toContain('token=');
    expect(report).toMatchObject({
      cmid: 5001,
      completed: false,
      dates: { opens: '2026-10-01T00:00:00+09:00', due: '2026-10-15T23:59:00+09:00' },
    });
    expect(label).toMatchObject({ cmid: 5104, modname: 'label', url: null });

    const [folder, quiz] = week2?.modules ?? [];
    expect(folder?.files.map((f) => f.name)).toEqual(['Case_A.xlsx', 'Case_B.docx']);
    expect(quiz).toMatchObject({
      completed: true,
      dates: { opens: '2026-10-14T09:00:00+09:00', closes: '2026-10-16T17:00:00+09:00' },
    });
  });

  it('asks Moodle for one section and filters by number', async () => {
    const { ctx, api } = makeFakeContext({ responses: responses() });
    const outline = await getCourseOutline(ctx, 101, { sectionNumber: 2 });
    expect(api.calls.find((c) => c.fn === CONTENTS)?.params).toEqual({
      courseid: 101,
      options: [{ name: 'sectionnumber', value: 2 }],
    });
    expect(outline.sections.map((s) => s.name)).toEqual(['Week 2']);
    await expect(getCourseOutline(ctx, 101, { sectionNumber: 9 })).rejects.toBeInstanceOf(NotFound);
  });

  it('falls back to a stand-in course when Moodle does not list it, and validates ids', async () => {
    const { ctx } = makeFakeContext({ responses: responses() });
    const outline = await getCourseOutline(ctx, 555);
    expect(outline.course).toMatchObject({ id: 555, name: 'Course 555' });
    await expect(getCourseOutline(ctx, 0)).rejects.toBeInstanceOf(InvalidInput);
    await expect(getCourseOutline(ctx, 101, { sectionNumber: -1 })).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe('searchCourseContent', () => {
  it('delegates to searchSnapshots with the resolved scope and a default limit', async () => {
    const { ctx } = makeFakeContext({ responses: { [TIMELINE]: timeline, [ENROL]: ENROLLED } });
    vi.mocked(searchSnapshots).mockClear();
    const res = await searchCourseContent(ctx, 'lecture');
    expect(res).toEqual({ hits: [], searchedCourses: 0, refreshed: 0, skipped: 0 });
    const [calledCtx, scope, query, opts] = vi.mocked(searchSnapshots).mock.calls[0] ?? [];
    expect(calledCtx).toBe(ctx);
    expect(scope?.mode).toBe('auto');
    expect([...(scope?.mine ?? [])]).toEqual([101]);
    expect(query).toBe('lecture');
    expect(opts).toEqual({ courseId: undefined, limit: 20 });
  });

  it('passes the course id through and caps the limit', async () => {
    const { ctx } = makeFakeContext({ responses: { [TIMELINE]: timeline, [ENROL]: ENROLLED } });
    vi.mocked(searchSnapshots).mockClear();
    await searchCourseContent(ctx, 'x', { courseId: 103, limit: 500 });
    expect(vi.mocked(searchSnapshots).mock.calls[0]?.[3]).toEqual({ courseId: 103, limit: 100 });
  });

  it('rejects an empty query and invalid limit / course ids before any Moodle call', async () => {
    const t = makeFakeContext({ responses: responses() });
    await expect(searchCourseContent(t.ctx, '  ')).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchCourseContent(t.ctx, 'x', { limit: 0 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchCourseContent(t.ctx, 'x', { limit: 1.5 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchCourseContent(t.ctx, 'x', { courseId: -1 })).rejects.toBeInstanceOf(InvalidInput);
    expect(t.api.calls).toHaveLength(0);
  });
});
