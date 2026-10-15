import { describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS } from '../../src/core/mcp/render/common';
import { renderDueByCourse } from '../../src/core/mcp/render/due-course';
import type { DueItem, DueList, DueSubmission } from '../../src/core/types';

const LIMIT = MAX_TEXT_CHARS + 200;

function due(patch: Partial<DueItem>): DueItem {
  return {
    kind: 'assign',
    courseId: 101,
    courseName: 'Course A',
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

const submittedAt = progress({ status: 'submitted', submittedAt: '2026-10-11T15:29:00+09:00' });

describe('renderDueByCourse', () => {
  const mixed = [
    due({
      name: 'Late report',
      cmid: 1,
      overdue: true,
      dueAt: '2026-10-10T23:59:00+09:00',
    }),
    due({
      name: 'Draft quiz',
      kind: 'quiz',
      cmid: 2,
      dueAt: '2026-10-16T18:00:00+09:00',
      submission: progress({ status: 'draft', canContinue: true }),
    }),
    due({ name: 'Open task', cmid: 3, dueAt: '2026-10-18T23:59:00+09:00' }),
    due({ name: 'Handed in', cmid: 4, dueAt: '2026-10-12T23:59:00+09:00', submission: submittedAt }),
  ];

  it('prints one course heading with all four counts and lists items overdue, draft, todo, submitted', () => {
    const t = renderDueByCourse(dueList(mixed));
    expect(t).toContain('## Course A (course_id 101) — overdue 1 · to do 1 · draft 1 · submitted 1');
    expect(t).not.toContain('## Submitted');
    expect(t).not.toContain('## Tomorrow');
    expect(t).toContain('3 items between');
    const late = t.indexOf('Late report');
    const draft = t.indexOf('Draft quiz');
    const open = t.indexOf('Open task');
    const done = t.indexOf('~~Handed in~~');
    expect([late, draft, open, done].every((i) => i >= 0)).toBe(true);
    expect(late).toBeLessThan(draft);
    expect(draft).toBeLessThan(open);
    expect(open).toBeLessThan(done);
    expect(t).toContain('~~Handed in~~ ✓ submitted 2026-10-11 Sun 15:29 — Course A');
    expect(t).toContain('Late report — Course A — due 2026-10-10 Sat 23:59 — OVERDUE (cmid 1)');
    expect(t).toContain('[draft saved — not submitted]');
  });

  it('lists courses in scope order then extras, and keeps zeros in the counts line', () => {
    const items = [
      due({ name: 'From A', courseId: 101, courseName: 'Course A', cmid: 1 }),
      due({ name: 'From C', courseId: 303, courseName: 'Course C', cmid: 3 }),
      due({ name: 'From B', courseId: 202, courseName: 'Course B', cmid: 2 }),
    ];
    const t = renderDueByCourse(dueList(items, { scope: { mode: 'mine', courseIds: [202, 101], otherCount: 1 } }));
    expect(t.indexOf('## Course B (course_id 202)')).toBeLessThan(t.indexOf('## Course A (course_id 101)'));
    expect(t.indexOf('## Course A (course_id 101)')).toBeLessThan(t.indexOf('## Course C (course_id 303)'));
    expect(t).toContain('## Course B (course_id 202) — overdue 0 · to do 1 · draft 0 · submitted 0');
    expect(t).toContain('3 items between');
  });

  it('drops submitted lines first when over budget and keeps overdue / to do', () => {
    const keep = [
      due({ name: 'Late one', overdue: true, dueAt: '2026-10-01T23:59:00+09:00', cmid: 1 }),
      due({ name: 'Still open', dueAt: '2026-10-20T23:59:00+09:00', cmid: 2, courseId: 202, courseName: 'Course B' }),
    ];
    const done = Array.from({ length: 80 }, (_, i) =>
      due({
        name: `Finished ${i}`,
        cmid: 4000 + i,
        submission: submittedAt,
      }),
    );
    const t = renderDueByCourse(
      dueList([...done, ...keep], { scope: { mode: 'mine', courseIds: [101, 202], otherCount: 0 } }),
    );
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toContain('Late one');
    expect(t).toContain('Still open');
    expect(t).toMatch(/… \d+ more \(see the console's Assignments & deadlines page\)/);
    expect(t).toContain('## Course A (course_id 101) — overdue 1 · to do 0 · draft 0 · submitted 80');
    expect(t).toContain('## Course B (course_id 202) — overdue 0 · to do 1 · draft 0 · submitted 0');
  });

  it('keeps a later course heading and note when earlier submitted lines fill the leftover', () => {
    // 41 A overdue lines: B fits as heading+note only; A's submitted then spend the leftover.
    const keepA = Array.from({ length: 41 }, (_, i) =>
      due({
        name: `Keep-${String(i).padStart(2, '0')}`,
        overdue: true,
        dueAt: '2026-10-01T23:59:00+09:00',
        cmid: 100 + i,
      }),
    );
    const doneA = Array.from({ length: 80 }, (_, i) =>
      due({
        name: `D${String(i).padStart(2, '0')}`,
        cmid: 4000 + i,
        submission: submittedAt,
      }),
    );
    const overdueB = due({
      name: 'B'.repeat(90),
      overdue: true,
      dueAt: '2026-10-01T23:59:00+09:00',
      courseId: 202,
      courseName: 'Course B',
      cmid: 9,
      evidence: 'e'.repeat(160),
    });
    const t = renderDueByCourse(
      dueList([...keepA, ...doneA, overdueB], { scope: { mode: 'mine', courseIds: [101, 202], otherCount: 0 } }),
    );
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toContain('## Course B (course_id 202)');
    expect(t).toMatch(/## Course B \(course_id 202\)[^\n]*\n… 1 more \(/);
    expect(t).toContain('~~D00~~');
    expect(t).not.toMatch(/… \d+ more courses/);
  });

  it('keeps the other-courses section and footer, and leaves closed items out of the course list', () => {
    const other = due({ courseId: 300, courseName: 'Other', name: 'Pre-course quiz', cmid: 9 });
    const closed = due({ name: 'Expired', overdue: true, closed: true, cmid: 8 });
    const t = renderDueByCourse(
      dueList([due({ name: 'Open task', cmid: 1 }), closed], {
        otherCourses: [other],
        scope: { mode: 'mine', courseIds: [101], otherCount: 2 },
      }),
    );
    expect(t).toContain('## Other enrolled courses (1)');
    expect(t).toContain('Pre-course quiz');
    expect(t).toContain('Your courses: 1.');
    expect(t).toContain('1 closed item no longer accepted: Expired');
    expect(t).not.toContain('Expired — Course A');
    expect(t).toContain('## Course A (course_id 101) — overdue 0 · to do 1 · draft 0 · submitted 0');
    expect(t.indexOf('## Other enrolled courses')).toBeGreaterThan(t.indexOf('Open task'));
  });

  it('keeps the footer and other-courses section when many long course names fill the body', () => {
    const title = 'International Corporate Strategy and Valuation Studies seminar series';
    const items = Array.from({ length: 15 }, (_, i) =>
      due({
        name: `Open task ${i}`,
        courseId: 200 + i,
        courseName: `${title} ${i}`,
        cmid: 10 + i,
      }),
    );
    const other = due({ courseId: 300, courseName: 'Other', name: 'Pre-course quiz', cmid: 9 });
    const closed = due({
      name: 'Expired',
      overdue: true,
      closed: true,
      cmid: 8,
      courseId: 200,
      courseName: `${title} 0`,
    });
    const list = dueList([...items, closed], {
      otherCourses: [other],
      scope: { mode: 'mine', courseIds: items.map((i) => i.courseId), otherCount: 2 },
    });
    const t = renderDueByCourse(list);
    expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(t).toContain('Assignments & deadlines. Times are JST');
    expect(t).not.toContain('Due items.');
    expect(t).toContain('## Other enrolled courses (1)');
    expect(t).toContain('Pre-course quiz');
    expect(t).toContain('Your courses: 15.');
    expect(t).toContain('1 closed item no longer accepted: Expired');
    expect(t).toMatch(/… \d+ more courses \(see the console's My courses page\)/);
    expect(t.indexOf('## Other enrolled courses')).toBeGreaterThan(t.indexOf('more courses'));

    const stdio = renderDueByCourse(list, { stdio: true });
    expect(stdio.length).toBeLessThanOrEqual(LIMIT);
    expect(stdio).toContain('## Other enrolled courses (1)');
    expect(stdio).toContain('Your courses: 15.');
    expect(stdio).toMatch(/… \d+ more courses$/m);
    expect(stdio).not.toContain("see the console's My courses page");
    expect(stdio.toLowerCase()).not.toContain('console');
  });
});
