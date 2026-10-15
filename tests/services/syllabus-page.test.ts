import { describe, expect, it } from 'vitest';
import { parseSyllabusPage } from '../../src/core/services/syllabus-page';
import { EMPTY_PAGE, EN_PAGE, ERROR_PAGE, FREE_TEXT_PAGE, JA_PAGE } from '../fixtures/syllabus';

describe('parseSyllabusPage (ja)', () => {
  const page = parseSyllabusPage(JA_PAGE, 'ja');

  it('reads the single-line cells by header text', () => {
    expect(page).toMatchObject({
      lang: 'ja',
      title: 'サンプル経営論',
      subtitle: '事例で学ぶ',
      year: '2026',
      school: 'Sample School',
      termDayPeriod: '秋クォーター 水３-４',
      category: 'Elective',
      credits: '2',
      classroom: '99-101（教室）',
      campus: '早稲田',
      language: '日本語',
      modality: '【対面】',
      updatedAt: '2026/05/15 12:37:49',
    });
    expect(page?.instructors).toEqual(['山田太郎', 'Sample Teacher']);
  });

  it('keeps line breaks of the rich-text cells and never runs into the next row', () => {
    expect(page?.outline).toBe('企業の戦略を学ぶ。\n\n事例を使って議論する。');
    expect(page?.objectives).toBe('・戦略を説明できる\n・事例を分析できる');
    expect(page?.prepost).toBe('事前：教科書を読む。\n事後：小テストを解く。');
    expect(page?.textbooks).toBe('山田太郎『サンプル経営論』架空出版、2025年。');
    expect(page?.references).toBe('授業中に指示する。');
    expect(page?.notes).toBe('質問は授業後に受け付けます。 https://example.com/info');
  });

  it('splits the plan table into sessions with title and topics', () => {
    expect(page?.planText).toBe('');
    expect(page?.sessions).toEqual([
      { no: '1', title: '第1回 ガイダンス', body: '授業の進め方\n評価方法' },
      { no: '2', title: '第2回 戦略の基礎', body: '競争優位' },
      { no: '3', title: '第3回 事例研究', body: '' },
    ]);
  });

  it('reads the grading table as method / weight / criteria rows', () => {
    expect(page?.gradingText).toBe('');
    expect(page?.grading).toEqual([
      { method: '試験', weight: 60, criteria: '第14回に実施する。\n持ち込み不可。' },
      { method: '平常点評価', weight: 40, criteria: '毎回の小テスト。' },
    ]);
  });
});

describe('parseSyllabusPage (en)', () => {
  const page = parseSyllabusPage(EN_PAGE, 'en');

  it('uses the English header texts', () => {
    expect(page).toMatchObject({
      lang: 'en',
      title: 'Sample Strategy',
      subtitle: null,
      termDayPeriod: 'fall quarter Wed.3-4',
      classroom: '99-101',
      campus: 'waseda',
      language: 'English',
      modality: '[On-campus]',
      outline: 'Firm strategy through cases.',
      prepost: 'Read the chapter before class.',
      textbooks: 'Taro Yamada, “Sample Strategy”, Example Press, 2025',
      notes: 'Office hours after class.',
      updatedAt: '2026/05/15 12:37:49',
    });
    expect(page?.instructors).toEqual(['YAMADA, Taro']);
  });

  it('parses sessions and the grading rows without their trailing colon', () => {
    expect(page?.sessions.map((s) => s.title)).toEqual(['Vol. 1 Introduction', 'Vol. 2 Basics']);
    expect(page?.grading.map((g) => [g.method, g.weight])).toEqual([
      ['Exam', 50],
      ['Class Participation', 10],
      ['Others', 40],
    ]);
    expect(page?.grading[2]?.criteria).toBe('Group\nPresentation');
  });
});

describe('parseSyllabusPage (free text, missing rows)', () => {
  const page = parseSyllabusPage(FREE_TEXT_PAGE, 'ja');

  it('keeps an unstructured plan as text, even when its row is left unclosed', () => {
    expect(page?.sessions).toEqual([]);
    expect(page?.planText).toMatch(/第1週\s*ガイダンス/);
    expect(page?.planText).toMatch(/第2週\s*小エッセイ\(1\)/);
    expect(page?.planText).not.toContain('ありません');
  });

  it('keeps unstructured grading as text with the weights in it', () => {
    expect(page?.grading).toEqual([]);
    expect(page?.gradingText).toMatch(/レポート\s*40％/);
    expect(page?.gradingText).toMatch(/相互評価\s*30％/);
  });

  it('leaves absent rows null / empty', () => {
    expect(page?.subtitle).toBeNull();
    expect(page?.classroom).toBeNull();
    expect(page?.instructors).toEqual([]);
    expect(page?.objectives).toBe('');
    expect(page?.notes).toBe('');
    expect(page?.updatedAt).toBeNull();
    expect(page?.textbooks).toBe('ありません。');
  });
});

describe('parseSyllabusPage (not a syllabus)', () => {
  it('returns null for the empty and error pages and for arbitrary HTML', () => {
    expect(parseSyllabusPage(EMPTY_PAGE, 'ja')).toBeNull();
    expect(parseSyllabusPage(ERROR_PAGE, 'ja')).toBeNull();
    expect(parseSyllabusPage('<table><tr><th>x</th><td>y</td></tr></table>', 'en')).toBeNull();
    expect(parseSyllabusPage('', 'ja')).toBeNull();
  });
});
