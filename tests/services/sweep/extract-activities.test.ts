import { describe, expect, it } from 'vitest';
import { dropCoveredText, nameTokens } from '../../../src/core/services/sweep/dedupe';
import {
  pendingActivityItems,
  taskModules,
  textDeadlineItems,
} from '../../../src/core/services/sweep/extract-activities';
import { buildSnapshot } from '../../../src/core/services/sweep/snapshot';
import type { DueItem } from '../../../src/core/types';
import { BASE, DAY, NOW_MS, NOW_SEC, rawSection } from './helpers';

const C = { id: 101, name: 'Valuation' };
const snap = (...mods: Parameters<typeof rawSection>[1]) =>
  buildSnapshot([rawSection(1, mods)], { baseUrl: BASE, now: NOW_MS });
const opts = { now: NOW_MS, toMs: NOW_MS + 14 * DAY };
const win = { now: NOW_MS, fromMs: NOW_MS - DAY, toMs: NOW_MS + 30 * DAY };

describe('pendingActivityItems', () => {
  it('lists undated, incomplete, visible pending activities only', () => {
    const items = pendingActivityItems(
      C,
      snap(
        { id: 1, modname: 'assign', name: 'Final upload', state: 0 },
        { id: 2, modname: 'assign', name: 'Done', state: 1 },
        { id: 3, modname: 'questionnaire', name: 'Intro survey' },
        {
          id: 4,
          modname: 'quiz',
          name: 'Dated',
          dates: [{ label: 'Closes', timestamp: NOW_SEC + 5, dataid: 'timeclose' }],
        },
        { id: 5, modname: 'resource', name: 'Slides' },
        { id: 6, modname: 'quiz', name: 'Hidden', visible: 0 },
        {
          id: 7,
          modname: 'quiz',
          name: 'Later',
          dates: [{ label: 'Opens', timestamp: NOW_SEC + 30 * 86400, dataid: 'timeopen' }],
        },
        {
          id: 8,
          modname: 'workshop',
          name: 'Opens soon',
          dates: [{ label: 'Opens', timestamp: NOW_SEC + 86400, dataid: 'timeopen' }],
        },
      ),
      opts,
    );
    expect(items.map((i) => i.cmid)).toEqual([1, 3, 8]);
    expect(items[0]).toMatchObject({
      source: 'activity',
      kind: 'assign',
      dueAt: null,
      evidence: null,
      sourceUrl: null,
      action: null,
      closed: false,
      overdue: false,
      notOpenYet: false,
      isNew: false,
      url: `${BASE}/mod/assign/view.php?id=1`,
    });
    expect(items[2]).toMatchObject({ kind: 'workshop', notOpenYet: true, opensAt: '2026-10-15T12:00:00+09:00' });
  });

  it('isNew when first seen within 72 h', () => {
    const s = snap({ id: 1, modname: 'assign', name: 'A' }, { id: 2, modname: 'assign', name: 'B' });
    const [a, b] = s.s[0]?.m ?? [];
    if (a && b) {
      a.s = NOW_MS - 71 * 3_600_000;
      b.s = NOW_MS - 73 * 3_600_000;
    }
    expect(pendingActivityItems(C, s, opts).map((i) => i.isNew)).toEqual([true, false]);
  });
});

describe('textDeadlineItems', () => {
  const s = buildSnapshot(
    [
      rawSection(
        2,
        [
          { id: 20, modname: 'resource', name: 'Report Due on 10/18' },
          { id: 21, modname: 'assign', name: 'Project Plan Form (due 23:00 p.m. on Oct 19 (Mon)' },
          { id: 22, modname: 'label', name: 'x', description: '<p>Hand in the memo by 10/21 12:00.</p>' },
          { id: 23, modname: 'page', name: 'Guide', description: '<p>Quiz closes 10月22日 17:00</p>' },
        ],
        '<p>10月15日（木）23：59までに以下の課題をやって、提出してください</p>',
        'Session 2',
      ),
    ],
    { baseUrl: BASE, now: NOW_MS },
  );

  it('extracts from module names, section summaries, labels and descriptions', () => {
    const items = textDeadlineItems(C, s, win);
    expect(items.map((i) => [i.name, i.dueAt, i.cmid])).toEqual([
      ['Report Due on 10/18', '2026-10-18T23:59:00+09:00', 20],
      ['Project Plan Form (due 23:00 p.m. on Oct 19 (Mon)', '2026-10-19T23:00:00+09:00', 21],
      ['Session 2', '2026-10-15T23:59:00+09:00', null],
      ['Session 2: Hand in the memo', '2026-10-21T12:00:00+09:00', null],
      ['Guide: Quiz', '2026-10-22T17:00:00+09:00', null],
    ]);
    expect(items[2]).toMatchObject({
      source: 'text',
      kind: 'other',
      url: `${BASE}/course/section.php?id=9002`,
      sourceUrl: `${BASE}/course/section.php?id=9002`,
      closed: false,
      action: null,
    });
    expect(items[2]?.evidence).toContain('10月15日(木)23:59');
    expect(items[0]).toMatchObject({ kind: 'other', sourceUrl: `${BASE}/mod/resource/view.php?id=20` });
    expect(items[1]?.kind).toBe('assign');
    expect(items[4]?.url).toBe(`${BASE}/mod/page/view.php?id=23`);
  });
});

describe('text items of task modules and titles', () => {
  const sec = (mods: Parameters<typeof rawSection>[1], summary = '', name = 'Week1 授業概要') =>
    buildSnapshot([rawSection(1, mods, summary, name)], { baseUrl: BASE, now: NOW_MS });

  it("a deadline in a task module's description carries that module (cmid, real name and kind)", () => {
    const s = sec([
      {
        id: 31,
        modname: 'questionnaire',
        name: 'Session 3 & 4 - Weekly Reflection Log',
        description: '<p>Deadline 18 October 2026 (Sunday) at 23.59</p>',
      },
      { id: 32, modname: 'feedback', name: 'Course feedback', description: '<p>Please answer by 10/20</p>' },
    ]);
    const items = textDeadlineItems(C, s, win);
    expect(items.map((i) => [i.kind, i.cmid, i.name, i.dueAt])).toEqual([
      ['questionnaire', 31, 'Session 3 & 4 - Weekly Reflection Log', '2026-10-18T23:59:00+09:00'],
      ['other', 32, 'Course feedback', '2026-10-20T23:59:00+09:00'],
    ]);
    expect(items[0]).toMatchObject({ source: 'text', sourceUrl: `${BASE}/mod/questionnaire/view.php?id=31` });
    expect(taskModules(s).has(31)).toBe(true);
  });

  it('ignores mentions of completed or hidden task modules', () => {
    const s = sec([
      { id: 41, modname: 'assign', name: 'Done', state: 1, description: '<p>Due 10/18</p>' },
      { id: 42, modname: 'assign', name: 'Hidden', visible: 0, description: '<p>Due 10/18</p>' },
      { id: 43, modname: 'assign', name: 'Done 10/19 due', state: 1 },
    ]);
    expect(textDeadlineItems(C, s, win)).toEqual([]);
  });

  it('names label / section / page mentions "<where>: <trigger phrase>" and keeps the evidence', () => {
    const s = sec(
      [
        { id: 51, modname: 'label', name: 'x', description: '<p>課題の説明。課題の提出 10月20日 までです</p>' },
        { id: 52, modname: 'page', name: 'Guide', description: '<p>Please send your plan by 10/21</p>' },
      ],
      '<p>10月15日（木）23：59までに以下の課題をやって</p>',
    );
    const items = textDeadlineItems(C, s, win);
    expect(items.map((i) => i.name)).toEqual([
      'Week1 授業概要',
      'Week1 授業概要: 課題の提出',
      'Guide: Please send your plan',
    ]);
    expect(items[1]?.evidence).toContain('課題の提出 10月20日');
    expect(items.every((i) => i.cmid === null && i.kind === 'other')).toBe(true);
  });
});

describe('practice material', () => {
  it('skips practice quizzes / h5p unless completion tracking says incomplete', () => {
    const items = pendingActivityItems(
      C,
      snap(
        { id: 1, modname: 'quiz', name: '小テスト（れんしゅう）' },
        { id: 2, modname: 'quiz', name: 'Practice Quiz 1' },
        { id: 3, modname: 'h5pactivity', name: 'Sample exercise' },
        { id: 4, modname: 'quiz', name: '模擬テスト' },
        { id: 5, modname: 'quiz', name: '練習問題', state: 0 },
        { id: 6, modname: 'quiz', name: 'Practice done', state: 1 },
        { id: 7, modname: 'quiz', name: 'Chapter 1 quiz' },
        { id: 8, modname: 'assign', name: 'Practice report' },
        { id: 9, modname: 'h5pactivity', name: 'ＰＲＡＣＴＩＣＥ' },
      ),
      opts,
    );
    expect(items.map((i) => i.cmid)).toEqual([5, 7, 8]);
  });
});

describe('dropCoveredText', () => {
  const base: DueItem = {
    kind: 'assign',
    courseId: 101,
    courseName: 'Valuation',
    cmid: 50,
    name: 'Report 1',
    opensAt: null,
    dueAt: '2026-10-18T23:59:00+09:00',
    midnightDue: false,
    overdue: false,
    closed: false,
    notOpenYet: false,
    url: '',
    action: null,
    source: 'calendar',
    evidence: null,
    sourceUrl: null,
    isNew: false,
    submission: null,
  };
  const text = (over: Partial<DueItem>): DueItem => ({
    ...base,
    source: 'text',
    cmid: null,
    name: 'Session 2',
    evidence: 'Report due on 10/18',
    ...over,
  });

  it('drops a text deadline on the same course and day that shares a name word', () => {
    const kept = dropCoveredText([text({})], [base]);
    expect(kept).toEqual([]);
  });

  it('keeps it for another day, another course or no shared word', () => {
    expect(dropCoveredText([text({ dueAt: '2026-10-19T23:59:00+09:00' })], [base])).toHaveLength(1);
    expect(dropCoveredText([text({ courseId: 7 })], [base])).toHaveLength(1);
    expect(dropCoveredText([text({ evidence: 'Hand in the memo 10/18' })], [base])).toHaveLength(1);
  });

  it('a calendar item owns its cmid whatever the date', () => {
    expect(dropCoveredText([text({ cmid: 50, evidence: 'zzz', dueAt: '2026-11-01T00:00:00+09:00' })], [base])).toEqual(
      [],
    );
  });

  it('midnight deadlines count as the previous day', () => {
    const cal = { ...base, dueAt: '2026-10-19T00:00:00+09:00' };
    expect(dropCoveredText([text({})], [cal])).toEqual([]);
  });

  it('Japanese names match by Han/Katakana bigrams', () => {
    expect(nameTokens('最終課題提出先').has('課題')).toBe(true);
    expect(nameTokens('Due 10/18 the Report').has('due')).toBe(false);
    const cal = { ...base, name: '最終課題' };
    expect(dropCoveredText([text({ evidence: '10月18日までに課題を提出' })], [cal])).toEqual([]);
  });
});
