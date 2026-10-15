import { describe, expect, it } from 'vitest';
import { attachTaskMentions } from '../../../src/core/services/sweep/task-mentions';
import type { DueItem } from '../../../src/core/types';

const item = (over: Partial<DueItem>): DueItem => ({
  kind: 'assign',
  courseId: 101,
  courseName: 'Valuation',
  cmid: 1,
  name: 'Task',
  opensAt: null,
  dueAt: null,
  midnightDue: false,
  overdue: false,
  closed: false,
  notOpenYet: false,
  url: '',
  action: null,
  source: 'activity',
  evidence: null,
  sourceUrl: null,
  isNew: false,
  submission: null,
  ...over,
});
const mention = (over: Partial<DueItem>) =>
  item({
    source: 'text',
    dueAt: '2026-10-18T23:59:00+09:00',
    evidence: 'Deadline 18 Oct',
    sourceUrl: 'https://moodle.example.edu/mod/assign/view.php?id=1',
    ...over,
  });

describe('attachTaskMentions', () => {
  const taskCmids = new Set([1, 2]);

  it('fills an undated activity, keeping its source', () => {
    const r = attachTaskMentions({ mentions: [mention({})], calendar: [], activities: [item({})], taskCmids });
    expect(r.standalone).toEqual([]);
    expect(r.activities).toEqual([
      item({
        dueAt: '2026-10-18T23:59:00+09:00',
        evidence: 'Deadline 18 Oct',
        sourceUrl: 'https://moodle.example.edu/mod/assign/view.php?id=1',
      }),
    ]);
  });

  it('prefers the calendar item and never overwrites a deadline', () => {
    const dated = item({ source: 'calendar', dueAt: '2026-10-25T09:00:00+09:00' });
    const r = attachTaskMentions({
      mentions: [mention({})],
      calendar: [dated],
      activities: [item({})],
      taskCmids,
    });
    expect(r.calendar).toEqual([dated]);
    expect(r.activities).toEqual([item({})]);
    expect(r.standalone).toEqual([]);
  });

  it('emits only the first mention of an unlisted task module; other mentions pass through', () => {
    const second = mention({ dueAt: '2026-10-19T23:59:00+09:00' });
    const forum = mention({ cmid: 55, kind: 'other' });
    const r = attachTaskMentions({
      mentions: [mention({ cmid: 2 }), second, mention({ cmid: 2 }), forum],
      calendar: [],
      activities: [],
      taskCmids,
    });
    expect(r.standalone.map((m) => m.cmid)).toEqual([2, 1]);
    expect(r.rest).toEqual([forum]);
  });
});
