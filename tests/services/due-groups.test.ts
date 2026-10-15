import { describe, expect, it } from 'vitest';
import { countDue, dueBucket } from '../../src/core/services/due-groups';
import type { DueItem, DueSubmission } from '../../src/core/types';

function item(patch: Partial<DueItem> = {}): DueItem {
  return {
    kind: 'assign',
    courseId: 1,
    courseName: 'Course A',
    cmid: 10,
    name: 'Task',
    opensAt: null,
    dueAt: '2026-10-15T23:59:00+09:00',
    midnightDue: false,
    overdue: false,
    closed: false,
    notOpenYet: false,
    url: 'https://moodle.example.edu/mod/assign/view.php?id=10',
    action: null,
    source: 'calendar',
    evidence: null,
    sourceUrl: null,
    isNew: false,
    submission: null,
    ...patch,
  };
}

const progress = (patch: Partial<DueSubmission>): DueSubmission => ({
  status: 'none',
  canContinue: false,
  submittedAt: null,
  graded: false,
  note: null,
  ...patch,
});

describe('dueBucket', () => {
  it('counts a submitted item as done even when overdue or closed', () => {
    const submitted = progress({ status: 'submitted' });
    expect(dueBucket(item({ submission: submitted }))).toBe('done');
    expect(dueBucket(item({ overdue: true, submission: submitted }))).toBe('done');
    expect(dueBucket(item({ closed: true, overdue: true, submission: submitted }))).toBe('done');
  });

  it('counts an overdue draft as overdue, not draft', () => {
    expect(dueBucket(item({ overdue: true, submission: progress({ status: 'draft' }) }))).toBe('overdue');
    expect(dueBucket(item({ overdue: true, submission: progress({ status: 'in-progress' }) }))).toBe('overdue');
    expect(dueBucket(item({ overdue: true, submission: null }))).toBe('overdue');
  });

  it('counts open draft, in-progress and reopened items as draft', () => {
    expect(dueBucket(item({ submission: progress({ status: 'draft' }) }))).toBe('draft');
    expect(dueBucket(item({ submission: progress({ status: 'in-progress' }) }))).toBe('draft');
    expect(dueBucket(item({ submission: progress({ status: 'reopened' }) }))).toBe('draft');
  });

  it('returns null for closed items that were not submitted', () => {
    expect(dueBucket(item({ closed: true, overdue: true }))).toBeNull();
    expect(dueBucket(item({ closed: true, overdue: true, submission: progress({ status: 'draft' }) }))).toBeNull();
  });

  it('counts other open items as todo', () => {
    expect(dueBucket(item({}))).toBe('todo');
    expect(dueBucket(item({ submission: progress({ status: 'none' }) }))).toBe('todo');
  });
});

describe('countDue', () => {
  it('tallies exclusive buckets and skips closed unsubmitted items', () => {
    const items = [
      item({ name: 'Late', overdue: true, cmid: 1 }),
      item({ name: 'Open', cmid: 2 }),
      item({ name: 'Draft', cmid: 3, submission: progress({ status: 'draft' }) }),
      item({ name: 'Done', cmid: 4, submission: progress({ status: 'submitted' }) }),
      item({ name: 'Gone', cmid: 5, overdue: true, closed: true }),
    ];
    expect(countDue(items)).toEqual({ overdue: 1, todo: 1, draft: 1, done: 1 });
    expect(countDue([])).toEqual({ overdue: 0, todo: 0, draft: 0, done: 0 });
  });
});
