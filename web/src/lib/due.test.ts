import { describe, expect, it } from 'vitest';
import type { DueItem } from '../api/types';
import { groupDue, isSubmitted, outstandingItems } from './due';

const now = Date.parse('2026-10-14T12:00:00+09:00');

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

describe('isSubmitted', () => {
  it('only counts submitted status', () => {
    expect(isSubmitted(item({ submission: sub('submitted') }))).toBe(true);
    expect(isSubmitted(item({ submission: sub('draft') }))).toBe(false);
    expect(isSubmitted(item({ submission: sub('in-progress') }))).toBe(false);
    expect(isSubmitted(item({ submission: null }))).toBe(false);
  });
});

describe('outstandingItems', () => {
  it('drops submitted items', () => {
    const a = item({ cmid: 1 });
    const b = item({ cmid: 2, submission: sub('submitted') });
    expect(outstandingItems([a, b])).toEqual([a]);
  });

  it('drops closed items and open items without a deadline; keeps ones opening later', () => {
    const closed = item({ cmid: 3, overdue: true, closed: true });
    const openSince = item({ cmid: 4, dueAt: null, opensAt: '2026-10-09T00:00:00+09:00' });
    const later = item({ cmid: 5, dueAt: null, opensAt: '2026-10-16T00:00:00+09:00', notOpenYet: true });
    expect(outstandingItems([closed, openSince, later])).toEqual([later]);
  });
});

describe('groupDue', () => {
  it('keeps a submitted future item in its date group', () => {
    const done = item({ cmid: 2, submission: sub('submitted') });
    const { groups } = groupDue([done], 'all', now);
    expect(groups).toEqual([{ group: 'week', items: [done] }]);
  });

  it('puts a submitted past item into past', () => {
    const done = item({ cmid: 2, dueAt: '2026-10-13T23:59:00+09:00', submission: sub('submitted') });
    expect(groupDue([done], 'all', now).groups).toEqual([{ group: 'past', items: [done] }]);
  });

  it('never treats a submitted item as overdue', () => {
    const done = item({ cmid: 2, overdue: true, dueAt: '2026-10-13T23:59:00+09:00', submission: sub('submitted') });
    const groups = groupDue([done], 'all', now).groups.map((g) => g.group);
    expect(groups).not.toContain('overdue');
    expect(groups).toEqual(['past']);
  });

  it('orders overdue, date groups, undated, past', () => {
    const past = item({ cmid: 1, dueAt: '2026-10-10T23:59:00+09:00', submission: sub('submitted') });
    const undated = item({ cmid: 2, dueAt: null, opensAt: null });
    const later = item({ cmid: 3, dueAt: '2026-11-30T23:59:00+09:00' });
    const today = item({ cmid: 4, dueAt: '2026-10-14T20:00:00+09:00', submission: sub('draft') });
    const late = item({ cmid: 5, overdue: true, dueAt: '2026-10-13T23:59:00+09:00' });
    const { groups } = groupDue([past, undated, later, today, late], 'all', now);
    expect(groups.map((g) => g.group)).toEqual(['overdue', 'today', 'later', 'undated', 'past']);
  });

  it('puts open items without a deadline into undated, submitted or not; not-yet-open ones by opening day', () => {
    const openSince = item({ cmid: 4, dueAt: null, opensAt: '2026-10-09T00:00:00+09:00' });
    const doneOpen = item({ cmid: 5, dueAt: null, opensAt: '2026-10-07T13:00:00+09:00', submission: sub('submitted') });
    const later = item({ cmid: 6, dueAt: null, opensAt: '2026-10-15T09:00:00+09:00', notOpenYet: true });
    const { groups } = groupDue([openSince, doneOpen, later], 'all', now);
    expect(groups).toEqual([
      { group: 'tomorrow', items: [later] },
      { group: 'undated', items: [openSince, doneOpen] },
    ]);
  });

  it('applies the course filter', () => {
    const a = item({ cmid: 1, courseId: 1, submission: sub('submitted') });
    const b = item({ cmid: 2, courseId: 2, submission: sub('submitted') });
    const c = item({ cmid: 3, courseId: 2 });
    const { groups } = groupDue([a, b, c], 2, now);
    expect(groups.flatMap((g) => g.items)).toEqual([b, c]);
  });

  it('returns no groups for no items', () => {
    expect(groupDue([], 'all', now)).toEqual({ groups: [] });
  });
});
