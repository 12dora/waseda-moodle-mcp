import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoodleError } from '../../../src/core/errors';
import { announcementItems } from '../../../src/core/services/sweep/announcements';
import { textDeadlineItems } from '../../../src/core/services/sweep/extract-activities';
import { findDeadlines } from '../../../src/core/services/sweep/extract-text';
import { refreshSnapshots } from '../../../src/core/services/sweep/refresh';
import { buildSnapshot, parseSnapshot } from '../../../src/core/services/sweep/snapshot';
import { BASE, course, DAY, MIN, makeFake, NOW, NOW_MS, rawSection, snapshotRow } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const CONTENTS = 'core_course_get_contents';
const UPDATES = 'core_course_get_updates_since';
const COMPLETION = 'core_completion_get_activities_completion_status';
const env = { baseUrl: BASE, now: NOW_MS };
const C = { id: 101, name: 'Course' };
const win = { now: NOW_MS, fromMs: NOW_MS - DAY, toMs: NOW_MS + 30 * DAY };
const snapOf = (...sections: ReturnType<typeof rawSection>[]) => buildSnapshot(sections, env);

describe('snapshot text', () => {
  it('keeps a section written only with full-width digits', () => {
    const snap = snapOf(rawSection(1, [], '<p>１０月２０日（火）２３：５９までにレポートを提出</p>'));
    expect(snap.x).toHaveLength(1);
    expect(snap.x[0]?.d?.[0]?.[0]).toBe(Date.parse('2026-10-20T23:59:00+09:00'));
    expect(textDeadlineItems(C, snap, win)[0]?.dueAt).toBe('2026-10-20T23:59:00+09:00');
  });

  it('references a section by its id and drops texts without a deadline', () => {
    const snap = snapOf(
      rawSection(5, [], '<p>Week 5 starts 10/20 with a lecture</p>'),
      rawSection(6, [], '<p>due 10/22</p>'),
    );
    expect(snap.x.map((t) => t.r)).toEqual(['s9006']);
  });

  it('keeps only texts with an upcoming deadline, and the later sections when over the cap', () => {
    const sections = Array.from({ length: 150 }, (_, i) =>
      rawSection(i + 1, [], i < 20 ? '<p>Report due on 9/20</p>' : '<p>Report due on 10/20</p>'),
    );
    const snap = snapOf(...sections);
    expect(snap.x).toHaveLength(120);
    expect(snap.x[0]?.r).toBe('s9031');
    expect(snap.x.at(-1)?.r).toBe('s9150');
    expect(snap.x.every((t) => t.d?.[0]?.[0] === Date.parse('2026-10-20T23:59:00+09:00'))).toBe(true);
  });

  it('estimates the raw size', () => {
    const big = rawSection(1, [{ id: 1, modname: 'label', name: 'x', description: 'y'.repeat(50_000) }]);
    expect(snapOf(big).z).toBeGreaterThan(50_000);
  });
});

describe('date keys', () => {
  it('maps lesson, workshop and questionnaire dates to due / closes / opens', () => {
    const d = (dataid: string, n: number) => ({ label: dataid, timestamp: 1_800_000_000 + n, dataid });
    const snap = snapOf(
      rawSection(1, [
        { id: 1, modname: 'lesson', name: 'L', dates: [d('available', 1), d('deadline', 2)] },
        { id: 2, modname: 'workshop', name: 'W', dates: [d('submissionstart', 3), d('submissionend', 4)] },
        { id: 3, modname: 'questionnaire', name: 'Q', dates: [d('opendate', 5), d('closedate', 6)] },
      ]),
    );
    const dates = snap.s[0]?.m.map((m) => m.d);
    expect(dates).toEqual([
      { opens: 1_800_000_001, due: 1_800_000_002 },
      { opens: 1_800_000_003, due: 1_800_000_004 },
      { opens: 1_800_000_005, closes: 1_800_000_006 },
    ]);
  });
});

describe('time words', () => {
  it('does not read 3時限 as 3:00', () => {
    const [d] = findDeadlines('10月15日 3時限までに提出', NOW_MS);
    expect(d?.ms).toBe(Date.parse('2026-10-15T23:59:00+09:00'));
    expect(findDeadlines('10月15日 3時までに提出', NOW_MS)[0]?.ms).toBe(Date.parse('2026-10-15T03:00:00+09:00'));
  });
});

describe("a task module's own description", () => {
  const reminder = '<p>第2回の質問・振り返り(提出期限10/15)を出しましたか</p>';
  const due = [{ label: 'Due', timestamp: Math.floor(NOW_MS / 1000) + 3600, dataid: 'duedate' }];

  it('gives no date to a module that has Moodle dates, or when the text only asks about another task', () => {
    const snap = snapOf(
      rawSection(1, [
        { id: 1, modname: 'assign', name: '質問・振り返り（第3回）', description: reminder },
        { id: 2, modname: 'assign', name: '質問・振り返り（第4回）', description: '<p>提出期限10/22</p>', dates: due },
        { id: 3, modname: 'assign', name: '質問・振り返り', description: '<p>第2回の提出期限10/15</p>' },
      ]),
    );
    expect(textDeadlineItems(C, snap, win)).toEqual([]);
  });

  it('lets an undated module take a date with an explicit deadline cue for itself', () => {
    const snap = snapOf(
      rawSection(1, [
        { id: 1, modname: 'assign', name: 'Final report', description: '<p>提出期限は10/22 23:59です</p>' },
        { id: 2, modname: 'assign', name: '第3回 課題', description: '<p>第3回の課題 10/20まで</p>' },
        { id: 3, modname: 'assign', name: 'Plan', description: '<p>Room 10/22 is booked for the review</p>' },
      ]),
    );
    expect(textDeadlineItems(C, snap, win).map((i) => [i.cmid, i.dueAt])).toEqual([
      [1, '2026-10-22T23:59:00+09:00'],
      [2, '2026-10-20T23:59:00+09:00'],
    ]);
  });
});

describe('own deadline evidence with links and cues', () => {
  const link = '<a href="https://moodle.example.edu/mod/assign/view.php?id=77">提出ページ</a>';
  const mod = (id: number, name: string, description: string) => ({ id, modname: 'assign', name, description });

  it('ignores `?` inside link targets and URLs, and accepts 提出日 / 提出： / 提出 + date as cues', () => {
    const snap = snapOf(
      rawSection(1, [
        mod(1, 'Final report', `<p>提出期限：10月20日 23:59 ${link}</p>`),
        mod(2, 'Plan', '<p>提出日：10/21 https://moodle.example.edu/x?id=5</p>'),
        mod(3, 'Memo', '<p>提出：10/22 Moodleへ</p>'),
        mod(4, 'Draft', '<p>Draft 提出10/23 Moodleへ</p>'),
      ]),
    );
    expect(textDeadlineItems(C, snap, win).map((i) => [i.cmid, i.dueAt])).toEqual([
      [1, '2026-10-20T23:59:00+09:00'],
      [2, '2026-10-21T23:59:00+09:00'],
      [3, '2026-10-22T23:59:00+09:00'],
      [4, '2026-10-23T23:59:00+09:00'],
    ]);
  });

  it('still rejects a question that ends with `?`', () => {
    const snap = snapOf(rawSection(1, [mod(1, 'Essay', '<p>提出10/23を忘れていませんか?</p>')]));
    expect(textDeadlineItems(C, snap, win)).toEqual([]);
  });
});

describe('text item cap', () => {
  const same = (n: number, text: string) => Array.from({ length: n }, (_, i) => rawSection(i + 1, [], text));

  it('applies the window before the cap: stale past items never crowd out a later deadline', () => {
    const fetched = { baseUrl: BASE, now: NOW_MS - 20 * DAY }; // stored dates outlive the fetch
    const snap = buildSnapshot(
      [...same(35, '<p>Report due on 10/1</p>'), rawSection(36, [], '<p>Report due on 10/16</p>', 'Late')],
      fetched,
    );
    expect(textDeadlineItems(C, snap, win).map((i) => i.dueAt)).toEqual(['2026-10-16T23:59:00+09:00']);
  });

  it('keeps the items closest to now when over the cap', () => {
    const soon = rawSection(36, [], '<p>Report due on 10/14 23:00</p>');
    const snap = snapOf(...same(35, '<p>Report due on 10/25</p>'), soon);
    const items = textDeadlineItems(C, snap, win);
    expect(items).toHaveLength(30);
    expect(items.some((i) => i.dueAt === '2026-10-14T23:00:00+09:00')).toBe(true);
  });
});

describe('refresh', () => {
  const oneMod = [rawSection(1, [{ id: 1, modname: 'assign', name: 'A', state: 0 }])];
  const row = (over: { fetchedAt?: number; checkedAt?: number; z?: number; id?: number } = {}) => {
    const snap = buildSnapshot(oneMod, env);
    if (over.z) snap.z = over.z;
    return {
      ...snapshotRow(over.id ?? 100, JSON.stringify(snap), over.checkedAt ?? NOW_MS - MIN),
      fetchedAt: over.fetchedAt ?? NOW_MS - MIN,
    };
  };

  it('refetches a snapshot older than the age limit even when it was just checked', async () => {
    const f = makeFake({ [CONTENTS]: () => oneMod }, [row({ fetchedAt: NOW_MS - 25 * 60 * MIN })]);
    const quiet = await refreshSnapshots(f.ctx, [course(100)], { maxCalls: 12, maxFull: 3 });
    expect(f.calls).toEqual([]); // interactive limit is longer
    expect(quiet.stats.checked).toBe(1);
    const r = await refreshSnapshots(f.ctx, [course(100)], { maxCalls: 12, maxFull: 3, maxAgeMs: 24 * 60 * MIN });
    expect(f.calls.map((c) => c.fn)).toEqual([CONTENTS]);
    expect(r.refreshed).toBe(1);
    expect(f.rows.get(100)?.fetchedAt).toBe(NOW_MS);
  });

  it('refreshes completion flags with one cheap call when only completion changed', async () => {
    const f = makeFake(
      {
        [UPDATES]: () => ({ instances: [{ id: 1, updates: [{ name: 'submissions' }] }] }),
        [COMPLETION]: () => ({ statuses: [{ cmid: 1, state: 1, tracking: 2 }] }),
      },
      [row({ checkedAt: NOW_MS - 40 * MIN, fetchedAt: NOW_MS - 3 * 60 * MIN })],
    );
    const r = await refreshSnapshots(f.ctx, [course(100)], { maxCalls: 12, maxFull: 3 });
    expect(f.calls.map((c) => c.fn)).toEqual([UPDATES, COMPLETION]);
    expect(f.calls[1]?.params).toEqual({ courseid: 100, userid: 1001 });
    expect(parseSnapshot(f.rows.get(100)?.json ?? '')?.s[0]?.m[0]?.k).toBe(1);
    expect(f.rows.get(100)).toMatchObject({ checkedAt: NOW_MS, fetchedAt: NOW_MS - 3 * 60 * MIN });
    expect(r.refreshed).toBe(0);
  });

  it('falls back to a refetch when the completion call fails', async () => {
    const f = makeFake(
      {
        [UPDATES]: () => ({ instances: [{ id: 1, updates: [{ name: 'completion' }] }] }),
        [COMPLETION]: () => {
          throw new MoodleError('nope', 'accessexception');
        },
        [CONTENTS]: () => oneMod,
      },
      [row({ checkedAt: NOW_MS - 40 * MIN })],
    );
    const r = await refreshSnapshots(f.ctx, [course(100)], { maxCalls: 12, maxFull: 3 });
    expect(r.refreshed).toBe(1);
  });

  it('refetches at most maxLarge courses known to be large', async () => {
    const f = makeFake(
      {
        [UPDATES]: () => ({ instances: [{ id: 1, updates: [{ name: 'configuration' }] }] }),
        [CONTENTS]: () => oneMod,
      },
      [100, 101, 102].map((id) => row({ id, z: 200_000, checkedAt: NOW_MS - DAY / 24 })),
    );
    const r = await refreshSnapshots(
      f.ctx,
      [100, 101, 102].map((id) => course(id)),
      { maxCalls: 12, maxFull: 3, maxLarge: 1 },
    );
    expect(r.refreshed).toBe(1);
    expect(f.calls.filter((c) => c.fn === CONTENTS)).toHaveLength(1);
  });
});

describe('announcement rotation', () => {
  const cs = Array.from({ length: 6 }, (_, i) => course(100 + i));
  const scanned = async (now: number) => {
    const f = makeFake({
      mod_forum_get_forums_by_courses: () => cs.map((c) => ({ id: c.id, course: c.id, cmid: c.id, type: 'news' })),
      mod_forum_get_forum_discussions: () => ({ discussions: [] }),
    });
    await announcementItems(await f.ctx.moodle(), cs, { now, maxCalls: 5 });
    return f.calls.filter((c) => c.fn === 'mod_forum_get_forum_discussions').map((c) => c.params.forumid);
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts at a random news forum on every run, wrapping around', async () => {
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0);
    expect(await scanned(NOW_MS)).toEqual([100, 101, 102, 103]);
    random.mockReturnValue(0.5);
    expect(await scanned(NOW_MS)).toEqual([103, 104, 105, 100]);
    random.mockReturnValue(0.99);
    expect(await scanned(NOW_MS)).toEqual([105, 100, 101, 102]);
  });

  it('does not depend on the time of day: a daily check at the same hour reaches every forum', async () => {
    const seen = new Set<unknown>();
    for (let run = 0; run < 40; run++) for (const id of await scanned(NOW_MS)) seen.add(id);
    expect(seen.size).toBe(6);
  });

  it('keeps every forum when there are not more than four', async () => {
    const few = cs.slice(0, 3);
    const f = makeFake({
      mod_forum_get_forums_by_courses: () => few.map((c) => ({ id: c.id, course: c.id, cmid: c.id, type: 'news' })),
      mod_forum_get_forum_discussions: () => ({ discussions: [] }),
    });
    await announcementItems(await f.ctx.moodle(), few, { now: NOW_MS, maxCalls: 5 });
    expect(f.calls.filter((c) => c.fn === 'mod_forum_get_forum_discussions')).toHaveLength(3);
  });
});
