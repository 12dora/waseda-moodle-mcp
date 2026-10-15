import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, NotFound } from '../../../src/core/errors';
import type { CourseScope } from '../../../src/core/services/scope';
import { collectSweepItems, getCourseUpdates, searchSnapshots } from '../../../src/core/services/sweep';
import { buildSnapshot } from '../../../src/core/services/sweep/snapshot';
import type { DueItem } from '../../../src/core/types';
import { BASE, course, DAY, MIN, makeFake, NOW, NOW_MS, NOW_SEC, rawSection, scopeOf, snapshotRow } from './helpers';

let scope: CourseScope;
vi.mock('../../../src/core/services/scope', () => ({ resolveScope: async () => scope }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const CONTENTS = 'core_course_get_contents';
const UPDATES = 'core_course_get_updates_since';
const FORUMS = 'mod_forum_get_forums_by_courses';
const DISCUSSIONS = 'mod_forum_get_forum_discussions';
const WINDOW = { fromMs: NOW_MS - 14 * DAY, toMs: NOW_MS + 14 * DAY };

const sectionsFor = (id: number) => [
  rawSection(
    1,
    [
      { id: id * 10 + 1, modname: 'assign', name: 'Final upload', state: 0 },
      { id: id * 10 + 2, modname: 'resource', name: 'Report Due on 10/18', files: ['Lecture notes.pdf'] },
      {
        id: id * 10 + 3,
        modname: 'quiz',
        name: 'Midterm',
        dates: [{ label: 'Closes', timestamp: NOW_SEC + 3600, dataid: 'timeclose' }],
      },
    ],
    '<p>Hand in the memo by 10月16日 17:00</p>',
    'Valuation basics',
  ),
];

function calendarItem(over: Partial<DueItem>): DueItem {
  return {
    kind: 'assign',
    courseId: 101,
    courseName: 'Valuation',
    cmid: 9999,
    name: 'Memo',
    opensAt: null,
    dueAt: '2026-10-16T17:00:00+09:00',
    midnightDue: false,
    overdue: false,
    closed: false,
    notOpenYet: false,
    url: '',
    action: 'Add submission',
    source: 'calendar',
    evidence: null,
    sourceUrl: null,
    isNew: false,
    submission: null,
    ...over,
  };
}

const announcements = {
  [FORUMS]: () => [
    { id: 5, course: 101, cmid: 55, type: 'news' },
    { id: 6, course: 101, cmid: 56, type: 'forum' },
  ],
  [DISCUSSIONS]: () => ({
    discussions: [
      {
        discussion: 71,
        subject: 'Case &amp; schedule',
        message: '<p>Case memo due 10/20 at 9am</p>',
        created: NOW_SEC - 3600,
      },
      { discussion: 70, subject: 'Old news', message: '<p>Due 10/21</p>', created: NOW_SEC - 20 * 86400 },
    ],
  }),
};

describe('collectSweepItems', () => {
  it('combines pending activities, text deadlines and announcements; calendar items win', async () => {
    const f = makeFake({ [CONTENTS]: () => sectionsFor(101), ...announcements });
    const sc = scopeOf(course(101, 'Valuation'));
    const { items, stats } = await collectSweepItems(f.ctx, sc, [calendarItem({})], WINDOW);
    const summary = items.map((i) => [i.source, i.name, i.dueAt]);
    expect(summary).toEqual([
      ['activity', 'Final upload', null],
      ['text', 'Report Due on 10/18', '2026-10-18T23:59:00+09:00'],
      ['text', 'Case & schedule', '2026-10-20T09:00:00+09:00'],
    ]);
    // the section summary "10月16日 17:00" is the calendar's Memo → dropped
    const announce = items[2];
    expect(announce).toMatchObject({
      kind: 'other',
      cmid: null, // the news forum (cmid 55) is where it was mentioned, not the task
      url: `${BASE}/mod/forum/discuss.php?d=71`,
      sourceUrl: `${BASE}/mod/forum/discuss.php?d=71`,
      isNew: true,
      closed: false,
      action: null,
    });
    expect(announce?.evidence).toContain('10/20');
    expect(stats).toEqual({ checked: 1, stale: 0, checkedAt: '2026-10-14T12:00:00+09:00' });
    expect(f.calls.length).toBeLessThanOrEqual(12);
  });

  it('keeps a text deadline the calendar does not cover; filters by window', async () => {
    const f = makeFake({ [CONTENTS]: () => sectionsFor(101), ...announcements });
    const sc = scopeOf(course(101));
    const { items } = await collectSweepItems(f.ctx, sc, [], { fromMs: NOW_MS, toMs: NOW_MS + 3 * DAY });
    expect(items.filter((i) => i.source === 'text').map((i) => i.dueAt)).toEqual(['2026-10-16T17:00:00+09:00']);
  });

  it('a date in a module name fills the undated activity item; the calendar owns its cmid', async () => {
    const f = makeFake({
      [CONTENTS]: () => [rawSection(1, [{ id: 7, modname: 'assign', name: 'Form (due Oct 19 (Mon)', state: 0 }])],
      [FORUMS]: () => [],
    });
    const sc = scopeOf(course(101));
    const a = await collectSweepItems(f.ctx, sc, [], WINDOW);
    expect(a.items.map((i) => [i.source, i.cmid, i.dueAt])).toEqual([['activity', 7, '2026-10-19T23:59:00+09:00']]);
    const b = await collectSweepItems(f.ctx, sc, [calendarItem({ cmid: 7, name: 'Form' })], WINDOW);
    expect(b.items).toEqual([]);
  });

  it("a deadline in a task module's own description is attached to its calendar item, not listed again", async () => {
    const survey = {
      id: 8,
      modname: 'questionnaire',
      name: 'Session 3 & 4 - Weekly Reflection Log',
      description: '<p>Deadline 18 October 2026 (Sunday) at 23.59</p>',
    };
    const f = makeFake({ [CONTENTS]: () => [rawSection(1, [survey])], [FORUMS]: () => [] });
    const sc = scopeOf(course(101));
    const opening = calendarItem({
      kind: 'questionnaire',
      cmid: 8,
      name: survey.name,
      dueAt: null,
      opensAt: '2026-10-01T09:00:00+09:00',
      url: `${BASE}/mod/questionnaire/view.php?id=8`,
    });
    const r = await collectSweepItems(f.ctx, sc, [opening], WINDOW);
    expect(r.items).toEqual([]);
    expect(r.calendar).toHaveLength(1);
    expect(r.calendar[0]).toMatchObject({
      source: 'calendar',
      cmid: 8,
      dueAt: '2026-10-18T23:59:00+09:00',
      overdue: false,
      sourceUrl: `${BASE}/mod/questionnaire/view.php?id=8`,
    });
    expect(r.calendar[0]?.evidence).toContain('18 October 2026');

    // a calendar item that has a deadline keeps it; the mention is dropped
    const dated = { ...opening, dueAt: '2026-10-20T23:59:00+09:00' };
    const kept = await collectSweepItems(f.ctx, sc, [dated], WINDOW);
    expect(kept.items).toEqual([]);
    expect(kept.calendar).toEqual([dated]);

    // not listed in the calendar: the undated activity takes the date its description states
    const g = makeFake({ [CONTENTS]: () => [rawSection(1, [survey])], [FORUMS]: () => [] });
    const alone = await collectSweepItems(g.ctx, sc, [], WINDOW);
    expect(alone.items.map((i) => [i.source, i.kind, i.cmid, i.name, i.dueAt])).toEqual([
      ['activity', 'questionnaire', 8, survey.name, '2026-10-18T23:59:00+09:00'],
    ]);

    // a module with Moodle dates of its own never takes a date from its description
    const closes = [{ label: 'Closes', timestamp: NOW_SEC + 40 * 86400, dataid: 'closedate' }];
    const h = makeFake({ [CONTENTS]: () => [rawSection(1, [{ ...survey, dates: closes }])], [FORUMS]: () => [] });
    expect((await collectSweepItems(h.ctx, sc, [], WINDOW)).items).toEqual([]);
  });

  it("drops text mentions older than 24 h, keeps the calendar's overdue logic", async () => {
    const f = makeFake({
      [CONTENTS]: () => [
        rawSection(1, [], '<p>Report due on 10/10</p>', 'Old'),
        rawSection(2, [], '<p>Report due on 10/13 12:30</p>', 'Yesterday'),
        rawSection(3, [], '<p>Report due on 10/14 09:00</p>', 'Hours ago'),
      ],
      [FORUMS]: () => [],
    });
    const sc = scopeOf(course(101));
    const { items } = await collectSweepItems(f.ctx, sc, [calendarItem({ overdue: true })], WINDOW);
    expect(items.map((i) => [i.name, i.dueAt, i.overdue])).toEqual([
      ['Yesterday: Report', '2026-10-13T12:30:00+09:00', true],
      ['Hours ago: Report', '2026-10-14T09:00:00+09:00', true],
    ]);
  });

  it('survives announcement failures and out-of-scope courses are not touched', async () => {
    const f = makeFake({
      [CONTENTS]: () => sectionsFor(101),
      [FORUMS]: () => [{ id: 5, course: 101, cmid: 55, type: 'news' }],
      [DISCUSSIONS]: () => {
        throw new MoodleError('no permission', 'noviewdiscussionspermission');
      },
    });
    const sc = scopeOf(course(101));
    sc.courses.push({ ...course(202), mine: false });
    const { items } = await collectSweepItems(f.ctx, sc, [], WINDOW);
    expect(items.some((i) => i.name === 'Final upload')).toBe(true);
    expect(f.calls.some((c) => c.params.courseid === 202)).toBe(false);
  });

  it('empty scope → nothing, no Moodle calls', async () => {
    const f = makeFake({});
    const r = await collectSweepItems(f.ctx, scopeOf(), [], WINDOW);
    expect(r).toEqual({ items: [], calendar: [], stats: { checked: 0, stale: 0, checkedAt: null } });
    expect(f.calls).toEqual([]);
  });

  it('remembers the scope by default, but not for a one-course call (rememberScope: false)', async () => {
    const f = makeFake({ [CONTENTS]: () => sectionsFor(101), [FORUMS]: () => [] });
    const sc = scopeOf(course(101, 'Valuation'));
    await collectSweepItems(f.ctx, sc, [], { ...WINDOW, rememberScope: false });
    expect(f.scopeWrites).toEqual([]);
    await collectSweepItems(f.ctx, sc, [], WINDOW);
    expect(f.scopeWrites).toEqual([[101]]);
  });

  it('cachedOnly spends no Moodle call: snapshots stay as stored, announcements are skipped', async () => {
    const stale = snapshotRow(
      101,
      JSON.stringify(buildSnapshot(sectionsFor(101), { baseUrl: BASE, now: NOW_MS })),
      NOW_MS - 5 * 3_600_000,
    );
    const f = makeFake({}, [stale]); // any call throws 'unexpected call'
    const sc = scopeOf(course(101, 'Valuation'), course(102, 'Law'));
    const { items, stats } = await collectSweepItems(f.ctx, sc, [], { ...WINDOW, cachedOnly: true });
    expect(f.calls).toEqual([]);
    expect(items.map((i) => i.name)).toContain('Final upload');
    expect(items.every((i) => i.courseId === 101)).toBe(true);
    expect(stats).toMatchObject({ checked: 0, stale: 2 });
    expect(f.scopeWrites).toEqual([]);
  });

  it('stays within 12 calls and 3 refetches with many courses', async () => {
    const cs = Array.from({ length: 9 }, (_, i) => course(100 + i));
    const f = makeFake({
      [CONTENTS]: (p) => sectionsFor(Number(p.courseid)),
      [FORUMS]: () => cs.map((c) => ({ id: c.id, course: c.id, cmid: c.id, type: 'news' })),
      [DISCUSSIONS]: () => ({ discussions: [] }),
    });
    const { stats } = await collectSweepItems(f.ctx, scopeOf(...cs), [], WINDOW);
    expect(f.calls.length).toBeLessThanOrEqual(12);
    expect(f.calls.filter((c) => c.fn === CONTENTS)).toHaveLength(3);
    expect(f.calls.filter((c) => c.fn === DISCUSSIONS).length).toBeLessThanOrEqual(4);
    expect(stats).toMatchObject({ checked: 3, stale: 6 });
  });
});

describe('searchSnapshots', () => {
  const cs = [course(101, 'Valuation'), course(102, 'Law')];
  const rows = cs.map((c) =>
    snapshotRow(c.id, JSON.stringify(buildSnapshot(sectionsFor(c.id), { baseUrl: BASE, now: NOW_MS })), NOW_MS - MIN),
  );

  it('matches names, files and section names; AND over terms; fresh snapshots need no calls', async () => {
    const f = makeFake({}, rows);
    const r = await searchSnapshots(f.ctx, scopeOf(...cs), 'LECTURE  notes', {});
    expect(r).toMatchObject({ searchedCourses: 2, refreshed: 0, skipped: 0 });
    expect(r.hits.map((h) => [h.courseId, h.module.name, h.module.files[0]?.name])).toEqual([
      [101, 'Report Due on 10/18', 'Lecture notes.pdf'],
      [102, 'Report Due on 10/18', 'Lecture notes.pdf'],
    ]);
    expect(f.calls).toEqual([]);
    const bySection = await searchSnapshots(f.ctx, scopeOf(...cs), 'basics midterm', { courseId: 102, limit: 5 });
    expect(bySection.hits.map((h) => [h.courseId, h.module.name, h.sectionName])).toEqual([
      [102, 'Midterm', 'Valuation basics'],
    ]);
    expect(bySection.hits[0]?.module.dates.closes).toBe('2026-10-14T13:00:00+09:00');
    const full = await searchSnapshots(f.ctx, scopeOf(...cs), '全角', {});
    expect(full.hits).toEqual([]);
  });

  it('refreshes missing snapshots (≤ 3), reports skipped, honours limit', async () => {
    const many = Array.from({ length: 5 }, (_, i) => course(300 + i));
    const f = makeFake({ [CONTENTS]: (p) => sectionsFor(Number(p.courseid)) });
    const r = await searchSnapshots(f.ctx, scopeOf(...many), 'upload', { limit: 2 });
    expect(r).toMatchObject({ searchedCourses: 3, refreshed: 3, skipped: 2 });
    expect(r.hits).toHaveLength(2);
  });

  it('validates input and the course', async () => {
    const f = makeFake({}, rows);
    await expect(searchSnapshots(f.ctx, scopeOf(...cs), '   ', {})).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchSnapshots(f.ctx, scopeOf(...cs), 'x', { courseId: 999 })).rejects.toBeInstanceOf(NotFound);
  });

  it('can look outside the scope with courseId', async () => {
    const f = makeFake({}, rows);
    const sc = scopeOf(cs[0] ?? course(1));
    sc.courses.push({ ...(cs[1] ?? course(2)), mine: false });
    const r = await searchSnapshots(f.ctx, sc, 'midterm', { courseId: 102 });
    expect(r.hits.map((h) => h.courseId)).toEqual([102]);
  });
});

describe('getCourseUpdates', () => {
  it('lists new and updated modules newest first within sinceDays', async () => {
    const oldSnap = buildSnapshot(sectionsFor(101), { baseUrl: BASE, now: NOW_MS });
    const checked = NOW_MS - 40 * MIN;
    const f = makeFake(
      {
        [UPDATES]: () => ({ instances: [{ id: 1012, updates: [{ name: 'contentfiles' }] }] }),
        [CONTENTS]: () => [
          rawSection(1, [
            { id: 1011, modname: 'assign', name: 'Final upload', state: 0 },
            { id: 1012, modname: 'resource', name: 'Report Due on 10/18', files: ['Lecture notes.pdf', 'Extra.pdf'] },
            {
              id: 1013,
              modname: 'quiz',
              name: 'Midterm',
              dates: [{ label: 'Closes', timestamp: NOW_SEC + 3600, dataid: 'timeclose' }],
            },
            { id: 1014, modname: 'url', name: 'Reading list' },
          ]),
        ],
      },
      [snapshotRow(101, JSON.stringify(oldSnap), checked)],
    );
    scope = scopeOf(course(101, 'Valuation'));
    const r = await getCourseUpdates(f.ctx, { sinceDays: 7 });
    expect(r.updates.map((u) => [u.cmid, u.change, u.what])).toEqual([
      [1012, 'updated', ['contentfiles']],
      [1014, 'new', []],
    ]);
    expect(r.updates[1]).toMatchObject({
      courseName: 'Valuation',
      url: `${BASE}/mod/url/view.php?id=1014`,
      at: '2026-10-14T12:00:00+09:00',
    });
    expect(r.stats.checked).toBe(1);
    expect((await getCourseUpdates(f.ctx, { courseId: 101 })).updates).toHaveLength(2);
    await expect(getCourseUpdates(f.ctx, { courseId: 5 })).rejects.toBeInstanceOf(NotFound);
  });
});
