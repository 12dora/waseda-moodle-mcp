import { describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS } from '../../src/core/mcp/render/common';
import { renderDueList } from '../../src/core/mcp/render/due';
import type { DueItem, DueList, DueSubmission } from '../../src/core/types';

const LIMIT = MAX_TEXT_CHARS + 200;

function due(patch: Partial<DueItem>): DueItem {
  return {
    kind: 'assign',
    courseId: 101,
    courseName: 'Strategic Marketing',
    cmid: 5001,
    name: 'Report 3',
    opensAt: null,
    dueAt: '2026-10-15T23:59:00+09:00',
    midnightDue: false,
    overdue: false,
    closed: false,
    notOpenYet: false,
    url: 'https://moodle.example.edu/mod/assign/view.php?id=5001',
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

function dueList(items: DueItem[], patch: Partial<DueList> = {}): DueList {
  return {
    generatedAt: '2026-10-14T12:00:00+09:00',
    windowFrom: '2026-09-30T12:00:00+09:00',
    windowTo: '2026-10-28T12:00:00+09:00',
    items,
    scope: { mode: 'mine', courseIds: [101], otherCount: 0 },
    otherCourses: [],
    sweep: { checked: 1, stale: 0, checkedAt: '2026-10-14T11:30:00+09:00' },
    truncated: false,
    ...patch,
  };
}

describe('renderDueList', () => {
  const items = [
    due({ name: 'Old report', dueAt: '2026-10-10T23:59:00+09:00', overdue: true, cmid: 1 }),
    due({ name: 'Today quiz', kind: 'quiz', dueAt: '2026-10-14T18:00:00+09:00', cmid: 2 }),
    due({ name: 'Midnight task', dueAt: '2026-10-15T00:00:00+09:00', midnightDue: true, cmid: 3 }),
    due({ name: 'Tomorrow task', dueAt: '2026-10-15T23:59:00+09:00', cmid: 4 }),
    due({ name: 'Week task', dueAt: '2026-10-18T23:59:00+09:00', cmid: 5 }),
    due({ name: 'Later task', dueAt: '2026-10-30T23:59:00+09:00', cmid: null }),
    due({
      name: 'Opens later',
      kind: 'questionnaire',
      dueAt: null,
      opensAt: '2026-10-20T09:00:00+09:00',
      notOpenYet: true,
      cmid: 6,
    }),
  ];
  const text = renderDueList(dueList(items));

  it('groups by urgency in order', () => {
    const order = ['## Overdue (1)', '## Today (2)', '## Tomorrow (1)', '## Next 7 days (2)', '## Later (1)'].map((h) =>
      text.indexOf(h),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('formats lines and shows a midnight deadline as the previous day 24:00', () => {
    expect(text).toContain('- [assign] Old report — Strategic Marketing — due 2026-10-10 Sat 23:59 — OVERDUE (cmid 1)');
    expect(text).toContain('Midnight task — Strategic Marketing — due 2026-10-14 Wed 24:00 (cmid 3)');
    expect(text).toContain('opens 2026-10-20 Tue 09:00');
    expect(text).not.toContain('(cmid null)');
    expect(text).toContain('JST');
  });

  it('reports truncation, and says when nothing is due', () => {
    const t = renderDueList(dueList([due({})], { truncated: true }));
    expect(t).toContain('narrow with course_id');
    expect(renderDueList(dueList([]))).toContain('Nothing outstanding');
    expect(renderDueList(dueList([due({ overdue: true, closed: true })]))).toContain(
      '1 closed item no longer accepted',
    );
  });

  describe('submission state', () => {
    const submitted = (name: string, patch: Partial<DueSubmission> = {}, over: Partial<DueItem> = {}) =>
      due({
        name,
        cmid: 800,
        overdue: false,
        submission: progress({ status: 'submitted', submittedAt: '2026-10-11T15:29:00+09:00', ...patch }),
        ...over,
      });
    const mixed = renderDueList(
      dueList([
        due({ name: 'Open task', cmid: 801 }),
        submitted('Session report', {}, { kind: 'questionnaire', dueAt: '2026-10-10T13:00:00+09:00' }),
        submitted('Final essay', { canContinue: true }, { cmid: 802, dueAt: '2026-10-14T18:00:00+09:00' }),
      ]),
    );

    it('keeps submitted items out of the outstanding groups, the counts and the headline', () => {
      expect(mixed).toContain('1 item between');
      expect(mixed).toContain('## Tomorrow (1)');
      expect(mixed).not.toContain('## Overdue');
      expect(mixed).not.toContain('## Today');
      expect(mixed).not.toMatch(/- \[assign\] Final essay[^\n]*due /);
    });

    it('lists them in a compact Submitted section after the outstanding groups', () => {
      expect(mixed).toContain('## Submitted (2)');
      expect(mixed.indexOf('## Submitted')).toBeGreaterThan(mixed.indexOf('## Tomorrow'));
      const at = 'Strategic Marketing — submitted 2026-10-11 Sun 15:29';
      expect(mixed).toContain(`- [assign] Final essay — ${at} — can still edit`);
      expect(mixed).toContain(`- [questionnaire] Session report — ${at}\n`);
      expect(mixed).not.toContain(`Session report — ${at} — can still edit`);
    });

    it('says nothing is outstanding when everything was submitted, and still lists the submitted items', () => {
      const t = renderDueList(dueList([submitted('Session report')]));
      expect(t).toContain('Nothing outstanding between');
      expect(t).toContain('## Submitted (1)');
      expect(t).not.toContain('1 item between');
    });

    it('shows a submitted item without a time as plain "submitted", newest first, and caps the list', () => {
      const many = Array.from({ length: 9 }, (_, i) =>
        submitted(`Done ${i}`, { submittedAt: `2026-10-0${i + 1}T10:00:00+09:00` }, { cmid: 900 + i }),
      );
      const t = renderDueList(dueList([...many, submitted('Undated', { submittedAt: null }, { cmid: 999 })]));
      expect(t).toContain('## Submitted (10)');
      expect(t).toContain('… 2 more');
      const shown = [...t.matchAll(/- \[assign\] (Done \d)/g)].map((m) => m[1]);
      expect(shown).toEqual(['Done 8', 'Done 7', 'Done 6', 'Done 5', 'Done 4', 'Done 3', 'Done 2', 'Done 1']);
      const lone = renderDueList(dueList([submitted('Undated', { submittedAt: null })]));
      expect(lone).toContain('- [assign] Undated — Strategic Marketing — submitted\n');
    });

    it('tags drafts, attempts in progress and reopened items in their date group; overdue stays', () => {
      const t = renderDueList(
        dueList([
          due({
            name: 'Draft report',
            cmid: 1,
            overdue: true,
            submission: progress({ status: 'draft', canContinue: true }),
          }),
          due({
            name: 'Running quiz',
            kind: 'quiz',
            cmid: 2,
            dueAt: '2026-10-14T18:00:00+09:00',
            submission: progress({ status: 'in-progress', canContinue: true }),
          }),
          due({ name: 'Again', cmid: 3, submission: progress({ status: 'reopened', canContinue: true }) }),
          due({ name: 'Fresh', cmid: 4, submission: progress({ status: 'none', canContinue: true }) }),
        ]),
      );
      expect(t).toContain('## Overdue (1)');
      const tomorrow = 'Strategic Marketing — due 2026-10-15 Thu 23:59';
      expect(t).toContain(`Draft report — ${tomorrow} — OVERDUE [draft saved — not submitted] (cmid 1)`);
      expect(t).toContain('## Today (1)');
      expect(t).toContain('[quiz] Running quiz');
      expect(t).toContain('— due 2026-10-14 Wed 18:00 [attempt in progress — not submitted] (cmid 2)');
      expect(t).toContain(`Again — ${tomorrow} [reopened for resubmission] (cmid 3)`);
      expect(t).toContain(`Fresh — ${tomorrow} (cmid 4)`);
      expect(t).not.toContain('## Submitted');
    });

    it('does not list submitted items of other courses', () => {
      const other = submitted('Elsewhere', {}, { courseId: 300, courseName: 'Other' });
      const t = renderDueList(dueList([due({})], { otherCourses: [other] }));
      expect(t).not.toContain('Other enrolled courses');
      expect(t).not.toContain('outside your selection');
    });

    it('stays within the size cap with many outstanding and submitted items', () => {
      const todo = Array.from({ length: 120 }, (_, i) => due({ name: `Task number ${i}`, cmid: 3000 + i }));
      const done = Array.from({ length: 40 }, (_, i) => submitted(`Finished ${i}`, {}, { cmid: 4000 + i }));
      const t = renderDueList(dueList([...todo, ...done]));
      expect(t.length).toBeLessThanOrEqual(LIMIT);
      expect(t).toContain('## Submitted (40)');
    });
  });

  it('marks activity items without a deadline and tags new items', () => {
    const t = renderDueList(
      dueList([due({ source: 'activity', dueAt: null, name: 'Final task', isNew: true, cmid: 77 })]),
    );
    expect(t).toContain('## No deadline (1)');
    expect(t).toContain('Final task — Strategic Marketing — no deadline set in Moodle — NEW (cmid 77)');
  });

  it('lists at most 5 "No deadline" lines, newest first, and counts the rest', () => {
    const undated = Array.from({ length: 8 }, (_, i) =>
      due({ source: 'activity', dueAt: null, name: `Undated ${i}`, cmid: 100 + i, isNew: i === 1 }),
    );
    const t = renderDueList(dueList(undated));
    expect(t).toContain('## No deadline (8)');
    const shown = [...t.matchAll(/- \[assign\] (Undated \d)/g)].map((m) => m[1]);
    expect(shown).toEqual(['Undated 1', 'Undated 7', 'Undated 6', 'Undated 5', 'Undated 4']);
    expect(t).toContain("… 3 more without a deadline (see the console's Due page)");
    const few = renderDueList(dueList(undated.slice(0, 5)));
    expect(few).not.toContain('more without a deadline');
  });

  it('lists calendar items of courses outside the selection last (max 5 lines) and mentions them in the footer', () => {
    const other = (n: number) =>
      due({ courseId: 300 + n, courseName: `Other ${n}`, name: `Pre-course quiz ${n}`, cmid: 9000 + n });
    const t = renderDueList(dueList([due({})], { otherCourses: [1, 2, 3, 4, 5, 6, 7].map(other) }));
    expect(t).toContain('## Other enrolled courses (7)');
    expect(t).toContain('Pre-course quiz 5');
    expect(t).not.toContain('Pre-course quiz 6');
    expect(t).toContain('… 2 more');
    expect(t.indexOf('## Other enrolled courses')).toBeGreaterThan(t.indexOf('Report 3'));
    expect(t).toContain('7 calendar deadlines in enrolled courses outside your selection are listed under');

    const one = renderDueList(dueList([], { otherCourses: [other(1)] }));
    expect(one).toContain('Nothing outstanding in your courses between');
    expect(one).toContain('## Other enrolled courses (1)');
    expect(one).not.toContain('… ');
    expect(renderDueList(dueList([due({})]))).not.toContain('Other enrolled courses');
  });

  it('counts only the open items of other courses, and lists upcoming ones before overdue ones', () => {
    const other = (name: string, over: Partial<DueItem>) => due({ courseId: 300, courseName: 'Other', name, ...over });
    const overdue = [1, 2, 3, 4, 5].map((n) => other(`Late ${n}`, { overdue: true }));
    const closed = other('Gone', { overdue: true, closed: true });
    const upcoming = other('Soon', { dueAt: '2026-10-20T23:59:00+09:00' });
    const t = renderDueList(dueList([due({})], { otherCourses: [closed, ...overdue, upcoming] }));
    expect(t).toContain('## Other enrolled courses (6)');
    expect(t).toContain('6 calendar deadlines in enrolled courses outside your selection are listed under');
    expect(t.indexOf('Soon')).toBeLessThan(t.indexOf('Late 1'));
    expect(t).toContain('Late 4');
    expect(t).not.toContain('Late 5');
    expect(t).toContain('… 1 more');

    const onlyClosed = renderDueList(dueList([], { otherCourses: [closed] }));
    expect(onlyClosed).toContain('Nothing outstanding between');
    expect(onlyClosed).not.toContain('Other enrolled courses');
    expect(onlyClosed).not.toContain('outside your selection');
  });

  it('shows the evidence of a date a calendar item took from its own module text', () => {
    const t = renderDueList(
      dueList([due({ evidence: 'Deadline 18 October 2026', sourceUrl: 'https://moodle.example.edu/mod/x?id=1' })]),
    );
    expect(t).toContain('mentioned in course text — verify');
    expect(t).toContain('«Deadline 18 October 2026» https://moodle.example.edu/mod/x?id=1');
  });

  it('quotes the evidence and link of deadlines found in course text', () => {
    const t = renderDueList(
      dueList([
        due({
          source: 'text',
          name: 'Report Due on 10/18',
          evidence: 'Report Due on 10/18 (Sun) 23:59 via the form',
          sourceUrl: 'https://moodle.example.edu/course/view.php?id=101#section-2',
        }),
      ]),
    );
    expect(t).toContain('mentioned in course text — verify');
    expect(t).toContain(
      '«Report Due on 10/18 (Sun) 23:59 via the form» https://moodle.example.edu/course/view.php?id=101#section-2',
    );
  });

  it('shows the scope and sweep coverage in the footer', () => {
    const mine = renderDueList(dueList([due({})], { scope: { mode: 'mine', courseIds: [1, 2, 3], otherCount: 4 } }));
    expect(mine).toContain('Your courses: 3.');
    expect(mine).toContain('4 other enrolled courses not included');
    expect(mine).toContain('Course pages checked: 1, last check 2026-10-14');
    const auto = renderDueList(
      dueList([due({})], {
        scope: { mode: 'auto', courseIds: [1, 2], otherCount: 0 },
        sweep: { checked: 1, stale: 2, checkedAt: null },
      }),
    );
    expect(auto).toContain('Using suggested courses (2)');
    expect(auto).toContain('set_my_courses');
    expect(auto).toContain('2 courses not refreshed yet');
  });

  it('truncates long lists with a "more" line', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      due({ name: `Assignment number ${i}`, dueAt: '2026-10-20T23:59:00+09:00', cmid: 9000 + i }),
    );
    const t = renderDueList(dueList(many));
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toMatch(/… \d+ more \(use course_id or a smaller days_ahead\)/);
  });
});

describe('renderDueList budget order', () => {
  it('keeps today and tomorrow when a long overdue list overflows, and puts closed items last', () => {
    const overdue = Array.from({ length: 80 }, (_, i) =>
      due({ name: `Old assignment number ${i}`, dueAt: '2026-10-01T23:59:00+09:00', overdue: true, cmid: 100 + i }),
    );
    const closed = due({
      name: 'Expired quiz',
      kind: 'quiz',
      dueAt: '2026-09-20T23:59:00+09:00',
      overdue: true,
      closed: true,
    });
    const items = [
      ...overdue,
      closed,
      due({ name: 'Due today', dueAt: '2026-10-14T20:00:00+09:00', cmid: 1 }),
      due({ name: 'Due tomorrow', dueAt: '2026-10-15T20:00:00+09:00', cmid: 2 }),
      due({ name: 'Due next week', dueAt: '2026-10-20T20:00:00+09:00', cmid: 3 }),
    ];
    const t = renderDueList(dueList(items));
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toContain('Due today');
    expect(t).toContain('Due tomorrow');
    expect(t).toContain('Due next week');
    expect(t).toMatch(/## Overdue \(80\)[\s\S]*… \d+ more/);
    expect(t.indexOf('## Overdue')).toBeLessThan(t.indexOf('## Today'));
    const last = t.trimEnd().split('\n').at(-1) ?? '';
    expect(last).toMatch(/^1 closed item no longer accepted: Expired quiz/);
    expect(t).not.toContain('- [quiz] Expired quiz');
  });

  it('puts open items without a deadline into a final "No deadline" group', () => {
    const items = [
      due({ name: 'Open survey', kind: 'questionnaire', dueAt: null, opensAt: '2026-10-10T09:00:00+09:00', cmid: 7 }),
      due({
        name: 'Survey opening tomorrow',
        kind: 'questionnaire',
        dueAt: null,
        opensAt: '2026-10-15T09:00:00+09:00',
        notOpenYet: true,
        cmid: 8,
      }),
      due({ name: 'Due today', dueAt: '2026-10-14T20:00:00+09:00', cmid: 1 }),
      due({ name: 'Far away', dueAt: '2026-11-30T20:00:00+09:00', cmid: 2 }),
    ];
    const t = renderDueList(dueList(items));
    expect(t).toContain('## No deadline (1)');
    expect(t).toContain('Open survey — Strategic Marketing — open since 2026-10-10 Sat 09:00, no deadline (cmid 7)');
    expect(t.indexOf('## No deadline')).toBeGreaterThan(t.indexOf('## Later'));
    expect(t.indexOf('Open survey')).toBeGreaterThan(t.indexOf('## No deadline'));
    // not yet open: keeps its opening time in the matching day group
    expect(t.indexOf('Survey opening tomorrow')).toBeGreaterThan(t.indexOf('## Tomorrow'));
    expect(t.indexOf('Survey opening tomorrow')).toBeLessThan(t.indexOf('## Later'));
    expect(t.indexOf('## Today')).toBeLessThan(t.indexOf('Due today'));
  });

  it('groups a deadline at 00:00 with the day it is shown on and uses generatedAt as now', () => {
    const list = dueList(
      [
        due({ name: 'Midnight', dueAt: '2026-10-22T00:00:00+09:00', midnightDue: true }),
        due({ name: 'Day after', dueAt: '2026-10-22T00:01:00+09:00' }),
      ],
      { generatedAt: '2026-10-14T12:00:00+09:00' },
    );
    const t = renderDueList(list);
    expect(t.indexOf('Midnight')).toBeLessThan(t.indexOf('## Later'));
    expect(t.indexOf('Day after')).toBeGreaterThan(t.indexOf('## Later'));
    expect(t).toContain('## Next 7 days (1)');
    expect(t).toContain('due 2026-10-21 Wed 24:00');
  });
});
