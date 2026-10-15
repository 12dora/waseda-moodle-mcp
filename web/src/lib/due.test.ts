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
});

describe('groupDue', () => {
  it('moves submitted items out of the outstanding groups', () => {
    const late = item({ cmid: 1, overdue: true, dueAt: '2026-10-13T23:59:00+09:00' });
    const done = item({ cmid: 2, submission: sub('submitted') });
    const draft = item({ cmid: 3, submission: sub('draft') });
    const { groups, submitted } = groupDue([late, done, draft], 'all', now);
    expect(submitted).toEqual([done]);
    expect(groups.map((g) => g.group)[0]).toBe('overdue');
    expect(groups.flatMap((g) => g.items)).toEqual([late, draft]);
  });

  it('applies the course filter to both lists', () => {
    const a = item({ cmid: 1, courseId: 1, submission: sub('submitted') });
    const b = item({ cmid: 2, courseId: 2, submission: sub('submitted') });
    const c = item({ cmid: 3, courseId: 2 });
    const { groups, submitted } = groupDue([a, b, c], 2, now);
    expect(submitted).toEqual([b]);
    expect(groups.flatMap((g) => g.items)).toEqual([c]);
  });

  it('returns empty lists for no items', () => {
    expect(groupDue([], 'all', now)).toEqual({ groups: [], submitted: [] });
  });
});
