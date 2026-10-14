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
const snapOf = (...sections: ReturnType<typeof rawSection>[]) => buildSnapshot(sections, env);

describe('snapshot text', () => {
  it('keeps a section written only with full-width digits', () => {
    const snap = snapOf(rawSection(1, [], '<p>１０月２０日（火）２３：５９までにレポートを提出</p>'));
    expect(snap.x).toHaveLength(1);
    expect(snap.x[0]?.d?.[0]?.[0]).toBe(Date.parse('2026-10-20T23:59:00+09:00'));
    expect(textDeadlineItems(C, snap, NOW_MS)[0]?.dueAt).toBe('2026-10-20T23:59:00+09:00');
  });

  it('references a section by its id and drops texts without a deadline', () => {
    const snap = snapOf(
      rawSection(5, [], '<p>Week 5 starts 10/20 with a lecture</p>'),
      rawSection(6, [], '<p>due 10/22</p>'),
    );
    expect(snap.x.map((t) => t.r)).toEqual(['s9006']);
  });

  it('keeps current deadlines and the later sections when over the cap', () => {
    const sections = Array.from({ length: 130 }, (_, i) =>
      rawSection(i + 1, [], i < 20 ? '<p>Report due on 9/20</p>' : '<p>Report due on 10/20</p>'),
    );
    const snap = snapOf(...sections);
    expect(snap.x).toHaveLength(120);
    expect(snap.x.at(-1)?.r).toBe('s9130');
    expect(snap.x.filter((t) => t.d?.[0]?.[0] === Date.parse('2026-09-20T23:59:00+09:00'))).toHaveLength(10);
    expect(snap.x.map((t) => t.r)).toEqual(
      [...snap.x.map((t) => t.r)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    );
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
    expect(textDeadlineItems(C, snap, NOW_MS)).toEqual([]);
  });

  it('lets an undated module take a date with an explicit deadline cue for itself', () => {
    const snap = snapOf(
      rawSection(1, [
        { id: 1, modname: 'assign', name: 'Final report', description: '<p>提出期限は10/22 23:59です</p>' },
        { id: 2, modname: 'assign', name: '第3回 課題', description: '<p>第3回の課題 10/20まで</p>' },
        { id: 3, modname: 'assign', name: 'Plan', description: '<p>Room 10/22 is booked for the review</p>' },
      ]),
    );
    expect(textDeadlineItems(C, snap, NOW_MS).map((i) => [i.cmid, i.dueAt])).toEqual([
      [1, '2026-10-22T23:59:00+09:00'],
      [2, '2026-10-20T23:59:00+09:00'],
    ]);
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
  it('starts at a different news forum every hour', async () => {
    const cs = Array.from({ length: 6 }, (_, i) => course(100 + i));
    const scanned = async (now: number) => {
      const f = makeFake({
        mod_forum_get_forums_by_courses: () => cs.map((c) => ({ id: c.id, course: c.id, cmid: c.id, type: 'news' })),
        mod_forum_get_forum_discussions: () => ({ discussions: [] }),
      });
      await announcementItems(await f.ctx.moodle(), cs, { now, maxCalls: 5 });
      return f.calls.filter((c) => c.fn === 'mod_forum_get_forum_discussions').map((c) => c.params.forumid);
    };
    const hour = Math.floor(NOW_MS / 3_600_000);
    const a = await scanned(NOW_MS);
    const b = await scanned(NOW_MS + 3_600_000);
    expect(a).toHaveLength(4);
    expect(a).not.toEqual(b);
    const all = new Set<unknown>();
    for (let h = 0; h < 6; h++) for (const id of await scanned((hour + h) * 3_600_000)) all.add(id);
    expect(all.size).toBe(6);
  });
});
