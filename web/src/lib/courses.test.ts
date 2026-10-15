import { describe, expect, it } from 'vitest';
import type { CourseOverviewItem, CourseSchedule, DueItem } from '../api/types';
import { classFirst, groupByBucket, scheduleKind } from './courses';

function item(over: Partial<DueItem>): DueItem {
  return {
    kind: 'assign',
    courseId: 1,
    courseName: 'A',
    cmid: 1,
    name: 'x',
    opensAt: null,
    dueAt: '2026-10-20T23:59:00+09:00',
    midnightDue: false,
    overdue: false,
    closed: false,
    notOpenYet: false,
    url: 'https://example.com',
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

const names = (groups: ReturnType<typeof groupByBucket>) => groups.map((g) => [g.bucket, g.items.map((it) => it.name)]);

describe('groupByBucket', () => {
  it('orders groups overdue, todo, draft, done and keeps item order', () => {
    const groups = groupByBucket([
      item({ name: 'done', submission: sub('submitted') }),
      item({ name: 'todo1' }),
      item({ name: 'draft', submission: sub('draft') }),
      item({ name: 'late', overdue: true }),
      item({ name: 'quiz', kind: 'quiz', submission: sub('in-progress') }),
      item({ name: 'todo2', submission: sub('none') }),
      item({ name: 'again', submission: sub('reopened') }),
    ]);
    expect(names(groups)).toEqual([
      ['overdue', ['late']],
      ['todo', ['todo1', 'todo2']],
      ['draft', ['draft', 'quiz', 'again']],
      ['done', ['done']],
    ]);
  });

  it('counts an overdue draft as overdue and never a submitted item', () => {
    const groups = groupByBucket([
      item({ name: 'lateDraft', overdue: true, submission: sub('draft') }),
      item({ name: 'handedIn', overdue: true, submission: sub('submitted') }),
    ]);
    expect(names(groups)).toEqual([
      ['overdue', ['lateDraft']],
      ['done', ['handedIn']],
    ]);
  });

  it('leaves out closed items that were not submitted', () => {
    const groups = groupByBucket([item({ name: 'closed', closed: true, overdue: true })]);
    expect(groups).toEqual([]);
  });

  it('returns no groups for no items', () => {
    expect(groupByBucket([])).toEqual([]);
  });
});

describe('scheduleKind', () => {
  const base: CourseSchedule = { slots: [], listing: null, alsoInClass: false, source: null };
  const slot = { weekday: 2, periodFrom: 3, periodTo: 4, start: '13:10', end: '14:50', classroom: null, campus: null };

  it('prefers weekly slots, also for hybrid courses', () => {
    expect(scheduleKind({ ...base, slots: [slot], listing: 'on-demand', alsoInClass: true, source: 'syllabus' })).toBe(
      'weekly',
    );
  });
  it('falls back to the listing', () => {
    expect(scheduleKind({ ...base, listing: 'on-demand', source: 'syllabus' })).toBe('on-demand');
    expect(scheduleKind({ ...base, listing: 'no-fixed-time', source: 'syllabus' })).toBe('no-fixed-time');
  });
  it('is unknown without slots or listing', () => {
    expect(scheduleKind(base)).toBe('unknown');
  });
});

describe('classFirst', () => {
  const course = (id: number, kind: CourseOverviewItem['kind']) => ({ id, kind }) as CourseOverviewItem;
  it('puts class courses first and keeps the order within each kind', () => {
    const out = classFirst([course(1, 'other'), course(2, 'class'), course(3, 'other'), course(4, 'class')]);
    expect(out.map((c) => c.id)).toEqual([2, 4, 1, 3]);
  });
});
