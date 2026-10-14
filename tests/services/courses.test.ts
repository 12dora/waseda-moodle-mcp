import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, NotFound } from '../../src/core/errors';
import {
  getCourseOutline,
  listCourses,
  mapCompleted,
  mapCourse,
  mapDates,
  mapSections,
  searchCourseContent,
} from '../../src/core/services/courses';
import { buildIndex, parseCourseIndex, parseQuery, searchIndex } from '../../src/core/services/courses-index';
import contentsFixture from '../fixtures/be2/course_contents.json';
import timeline from '../fixtures/be2/timeline_courses.json';
import { makeFakeContext, makeFakeStore } from '../helpers/fake-context';

const TIMELINE = 'core_course_get_enrolled_courses_by_timeline_classification';
const CONTENTS = 'core_course_get_contents';
const NOW = new Date('2026-10-14T03:00:00Z'); // 2026-10-14 12:00 JST
const HOUR = 3600 * 1000;

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

function responses(inprogress: unknown[] = timeline.courses.slice(0, 2)) {
  return {
    [TIMELINE]: (p: Record<string, unknown>) => ({
      courses: p.classification === 'inprogress' ? inprogress : timeline.courses,
    }),
    [CONTENTS]: (p: Record<string, unknown>) => courseContents(p.courseid as number),
  };
}

describe('listCourses', () => {
  it('defaults to in-progress, decodes names and maps fields', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [TIMELINE]: timeline } });
    const courses = await listCourses(ctx);
    expect(api.calls).toEqual([{ fn: TIMELINE, params: { classification: 'inprogress', limit: 0 } }]);
    expect(courses).toHaveLength(4);
    expect(courses[0]).toEqual({
      id: 101,
      name: 'Introduction to Finance & Accounting',
      shortName: 'FIN101',
      category: 'Business & Commerce',
      url: 'https://moodle.example.edu/course/view.php?id=101',
      start: '2026-09-01T00:00:00+09:00',
      end: '2027-01-31T00:00:00+09:00',
      progress: 40,
      hidden: false,
    });
    expect(courses[1]?.progress).toBeNull(); // hasprogress=false
  });

  it('excludes courses hidden in settings unless includeHidden', async () => {
    const { ctx } = makeFakeContext({
      responses: { [TIMELINE]: timeline },
      user: { settings: { hiddenCourseIds: [103] } },
    });
    expect((await listCourses(ctx)).map((c) => c.id)).toEqual([101, 102, 104]);
    const all = await listCourses(ctx, { includeHidden: true });
    expect(all.map((c) => [c.id, c.hidden])).toEqual([
      [101, false],
      [102, false],
      [103, true],
      [104, false],
    ]);
  });

  it('passes the classification through and accepts a bare array response', async () => {
    const { ctx, api } = makeFakeContext({ responses: { [TIMELINE]: timeline.courses } });
    const courses = await listCourses(ctx, { classification: 'past' });
    expect(api.calls[0]?.params).toEqual({ classification: 'past', limit: 0 });
    expect(courses).toHaveLength(4);
  });
});

describe('mappers', () => {
  it('mapCourse builds a fallback url and clamps progress', () => {
    const c = mapCourse({ id: 7, fullname: 'A', progress: 150, hasprogress: true }, new Set([7]), 'https://m.example');
    expect(c.url).toBe('https://m.example/course/view.php?id=7');
    expect(c.progress).toBe(100);
    expect(c.hidden).toBe(true);
    expect(c.category).toBeNull();
  });

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

  it('parseQuery applies NFKC and lower-casing', () => {
    expect(parseQuery('  ＬＥＣＴＵＲＥ  Slides ')).toEqual(['lecture', 'slides']);
    expect(parseQuery('   ')).toEqual([]);
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
  it('builds the index on first use and finds modules by name', async () => {
    const t = makeFakeContext({ responses: responses() });
    const res = await searchCourseContent(t.ctx, 'lecture slides');
    expect(res).toMatchObject({ searchedCourses: 2, refreshed: 2 });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({
      courseId: 101,
      courseName: 'Introduction to Finance & Accounting',
      sectionName: 'Week 1 & Orientation',
      module: { cmid: 5102, modname: 'resource', completed: null },
    });
    expect(res.hits[0]?.module.files[0]?.name).toBe('Lecture1_Slides.pdf');

    expect(t.state.indexWrites).toHaveLength(2);
    const stored = t.state.indexWrites.find((w) => w.courseId === 101);
    expect(stored).toMatchObject({ userId: t.ctx.user.id, courseId: 101, updatedAt: NOW.getTime() });
    expect(stored?.json).not.toContain('Intro week'); // summaries are dropped
    expect(stored?.json).not.toContain('2026-10'); // dates are dropped
    expect(parseCourseIndex(stored?.json ?? '')?.v).toBe(1);
  });

  it('reuses a fresh index and refreshes one older than 6 hours', async () => {
    const first = makeFakeContext({ responses: responses() });
    await searchCourseContent(first.ctx, 'handout');
    const shared = { store: first.store, state: first.state };

    vi.setSystemTime(new Date(NOW.getTime() + 5 * HOUR));
    const second = makeFakeContext({ responses: responses(), store: shared });
    expect(await searchCourseContent(second.ctx, 'handout')).toMatchObject({ refreshed: 0, searchedCourses: 2 });
    expect(second.api.count(CONTENTS)).toBe(0);

    vi.setSystemTime(new Date(NOW.getTime() + 7 * HOUR));
    const third = makeFakeContext({ responses: responses(), store: shared });
    expect(await searchCourseContent(third.ctx, 'handout')).toMatchObject({ refreshed: 2, searchedCourses: 2 });
    expect(third.api.count(CONTENTS)).toBe(2);
  });

  it('refreshes at most 8 courses per call and catches up on the next one', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: 201 + i, fullname: `Course ${201 + i}`, shortname: 'C' }));
    const first = makeFakeContext({ responses: responses(many) });
    const r1 = await searchCourseContent(first.ctx, 'handout');
    expect(r1).toMatchObject({ refreshed: 8, searchedCourses: 8, skipped: 2 });
    expect(r1.hits).toHaveLength(8);
    expect(first.api.count(CONTENTS)).toBe(8);

    const second = makeFakeContext({ responses: responses(many), store: { store: first.store, state: first.state } });
    const r2 = await searchCourseContent(second.ctx, 'handout');
    expect(r2).toMatchObject({ refreshed: 2, searchedCourses: 10, skipped: 0 });
    expect(r2.hits).toHaveLength(10);
    expect(second.api.count(CONTENTS)).toBe(2);
  });

  it('limits to one course (even a hidden one) and matches file names', async () => {
    const t = makeFakeContext({ responses: responses(), user: { settings: { hiddenCourseIds: [101] } } });
    const res = await searchCourseContent(t.ctx, 'case_a', { courseId: 101 });
    expect(res).toMatchObject({ searchedCourses: 1, refreshed: 1 });
    expect(res.hits.map((h) => h.module.cmid)).toEqual([5105]);
    expect(t.api.calls.find((c) => c.fn === TIMELINE)?.params).toEqual({
      classification: 'allincludinghidden',
      limit: 0,
    });
    expect(t.api.count(CONTENTS)).toBe(1);
  });

  it('skips courses hidden in settings', async () => {
    const t = makeFakeContext({ responses: responses(), user: { settings: { hiddenCourseIds: [102] } } });
    expect(await searchCourseContent(t.ctx, 'handout')).toMatchObject({ searchedCourses: 1, refreshed: 1, hits: [] });
  });

  it('matches section names with all terms (AND) and applies NFKC', async () => {
    const t = makeFakeContext({ responses: responses() });
    const bySection = await searchCourseContent(t.ctx, 'orientation');
    expect(bySection.hits.map((h) => h.module.cmid)).toEqual([5102, 5001, 5104]);
    const mixed = await searchCourseContent(t.ctx, 'report orientation');
    expect(mixed.hits.map((h) => h.module.cmid)).toEqual([5001]);
    const wide = await searchCourseContent(t.ctx, 'ＬＥＣＴＵＲＥ');
    expect(wide.hits.map((h) => h.module.cmid)).toEqual([5102]);
    expect((await searchCourseContent(t.ctx, 'week', { limit: 1 })).hits).toHaveLength(1);
  });

  it('ranks module/file-name matches above section-only matches', async () => {
    const json = JSON.stringify({
      v: 1,
      name: 'x',
      s: [
        {
          i: 1,
          k: 1,
          n: 'Report Templates',
          m: [
            { c: 1, n: 'Intro', t: 'page', u: null },
            {
              c: 2,
              n: 'Report 2',
              t: 'resource',
              u: null,
              f: [['r2.pdf', 'https://moodle.example.edu/webservice/pluginfile.php/1/a/r2.pdf', 10, 'application/pdf']],
            },
          ],
        },
      ],
    });
    const store = makeFakeStore({ courseIndex: [{ userId: 1, courseId: 101, json, updatedAt: NOW.getTime() }] });
    const t = makeFakeContext({ responses: responses(timeline.courses.slice(0, 1)), store });
    const res = await searchCourseContent(t.ctx, 'report');
    expect(res).toMatchObject({ refreshed: 0, searchedCourses: 1 });
    expect(t.api.count(CONTENTS)).toBe(0);
    expect(res.hits.map((h) => h.module.cmid)).toEqual([2, 1]);
    expect(res.hits[0]?.courseName).toBe('Introduction to Finance & Accounting');
    expect(res.hits[0]?.module.files[0]).toEqual({
      name: 'r2.pdf',
      size: 10,
      mime: 'application/pdf',
      url: 'https://moodle.example.edu/webservice/pluginfile.php/1/a/r2.pdf',
      modified: null,
    });
  });

  it('treats an unreadable index row as missing', async () => {
    const store = makeFakeStore({
      courseIndex: [{ userId: 1, courseId: 101, json: '{bad', updatedAt: NOW.getTime() }],
    });
    const t = makeFakeContext({ responses: responses(timeline.courses.slice(0, 1)), store });
    expect(await searchCourseContent(t.ctx, 'lecture')).toMatchObject({ refreshed: 1, searchedCourses: 1 });
  });

  it('keeps going when one course cannot be read', async () => {
    const base = responses();
    const t = makeFakeContext({
      responses: {
        ...base,
        [CONTENTS]: (p: Record<string, unknown>) => {
          if (p.courseid === 102) throw new MoodleError('no access', 'nopermissions');
          return courseContents(p.courseid as number);
        },
      },
    });
    expect(await searchCourseContent(t.ctx, 'lecture')).toMatchObject({ refreshed: 1, searchedCourses: 1 });
  });

  it('rejects an empty query and invalid limit / course ids', async () => {
    const t = makeFakeContext({ responses: responses() });
    await expect(searchCourseContent(t.ctx, '  ')).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchCourseContent(t.ctx, 'x', { limit: 0 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchCourseContent(t.ctx, 'x', { limit: 1.5 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchCourseContent(t.ctx, 'x', { courseId: -1 })).rejects.toBeInstanceOf(InvalidInput);
    expect(t.api.calls).toHaveLength(0);
  });
});

describe('index helpers', () => {
  it('searchIndex and buildIndexJson round-trip a compact index', async () => {
    const { ctx } = makeFakeContext({ responses: responses() });
    const outline = await getCourseOutline(ctx, 101);
    const payload = parseCourseIndex(JSON.stringify(buildIndex(outline)));
    expect(payload?.name).toBe('Introduction to Finance & Accounting');
    const hits = searchIndex(payload as NonNullable<typeof payload>, { id: 101, name: 'X' }, ['quiz']);
    expect(hits.map((h) => h.hit.module.cmid)).toEqual([5002]);
    expect(parseCourseIndex('not json')).toBeNull();
  });
});
