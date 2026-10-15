import { describe, expect, it } from 'vitest';
import { EVIDENCE_MAX, findDeadlines, inferDeadlineMs } from '../../../src/core/services/sweep/extract-text';
import { fmt, isoJst } from '../../../src/core/time';
import { DAY, NOW_MS } from './helpers';

const jst = (text: string) => findDeadlines(text, NOW_MS).map((d) => isoJst(d.ms).slice(0, 16));

describe('findDeadlines', () => {
  it('Japanese date with full-width digits and colon, weekday, "まで"', () => {
    expect(jst('１０月１５日（木）２３：５９までに以下の課題をやって、提出してください')).toEqual(['2026-10-15T23:59']);
    expect(jst('10月15日（木）23：59までに以下の課題をやって、提出してください')).toEqual(['2026-10-15T23:59']);
  });

  it('"Report Due on 10/18" defaults to 23:59', () => {
    expect(jst('Report Due on 10/18')).toEqual(['2026-10-18T23:59']);
  });

  it('noon', () => {
    expect(jst('Report Assignment (Due: Noon of 10/4)')).toEqual(['2026-10-04T12:00']);
    expect(jst('レポート 10月20日 正午まで')).toEqual(['2026-10-20T12:00']);
  });

  it('"23:00 p.m." is 23:00 and a month name with weekday works', () => {
    expect(jst('Project Plan Form (due 23:00 p.m. on Oct 19 (Mon)')).toEqual(['2026-10-19T23:00']);
  });

  it('12-hour time before the date', () => {
    expect(jst('Preparation Task for Session 05-06, Due 11 PM, 10/12 (Mon)')).toEqual(['2026-10-12T23:00']);
  });

  it('English month spellings and day-first order', () => {
    expect(jst('Submit by October 20, 11:30 am')).toEqual(['2026-10-20T11:30']);
    expect(jst('Deadline: 21st of Oct, 5pm')).toEqual(['2026-10-21T17:00']);
    expect(jst('Hand in before 22 Oct 18:00')).toEqual(['2026-10-22T18:00']);
    expect(jst('due Oct. 23')).toEqual(['2026-10-23T23:59']);
  });

  it('Japanese clock words: 時/分/午後', () => {
    expect(jst('提出期限 10月16日 午後5時')).toEqual(['2026-10-16T17:00']);
    expect(jst('提出期限 10月16日 23時30分')).toEqual(['2026-10-16T23:30']);
  });

  it('explicit years, ISO form', () => {
    expect(jst('Due 2027-01-15 12:00')).toEqual(['2027-01-15T12:00']);
    expect(jst('提出 2026年11月3日 まで')).toEqual(['2026-11-03T23:59']);
  });

  it('00:00 stays 00:00 (midnight is handled by the item mapper)', () => {
    expect(jst('Due 10/20 0:00')).toEqual(['2026-10-20T00:00']);
    expect(jst('Due 10/20 24:00')).toEqual(['2026-10-21T00:00']);
  });

  it('time belongs to the nearest date and never crosses a neighbouring date', () => {
    const got = jst('Report 1 due 10/16; Report 2 due 10/23 at 17:00');
    expect(got).toEqual(['2026-10-16T23:59', '2026-10-23T17:00']);
  });

  it('ignores opening dates, ranges and cue-less dates', () => {
    expect(jst('Opens 10/15, submit by 10/20')).toEqual(['2026-10-20T23:59']);
    expect(jst('Available from Oct 15 until Oct 20')).toEqual(['2026-10-20T23:59']);
    expect(jst('10月15日〜10月20日 提出期間')).toEqual(['2026-10-20T23:59']);
    expect(jst('10/20 - 10/25 report')).toEqual(['2026-10-25T23:59']);
    expect(jst('Week 3: 10/20 Introduction to valuation')).toEqual([]);
  });

  it('year inference: closest date within [-30 d, +180 d]', () => {
    const dec = Date.parse('2026-12-20T03:00:00Z');
    expect(findDeadlines('Due 1/10', dec).map((d) => isoJst(d.ms).slice(0, 10))).toEqual(['2027-01-10']);
    const jan = Date.parse('2027-01-05T03:00:00Z');
    expect(findDeadlines('Due 12/28', jan).map((d) => isoJst(d.ms).slice(0, 10))).toEqual(['2026-12-28']);
    expect(jst('Due 8/1')).toEqual([]); // 74 days back
  });

  it('rejects impossible dates', () => {
    expect(jst('Due 2/30')).toEqual([]);
    expect(jst('Due 13/5')).toEqual([]);
    expect(inferDeadlineMs({ y: null, mo: 2, d: 30 }, { h: 0, mi: 0 }, NOW_MS)).toBeNull();
  });

  it('evidence is a trimmed snippet of at most 160 chars around the date', () => {
    const filler = 'x '.repeat(200);
    const [d] = findDeadlines(`${filler}Report due on 10/18 please${filler}`, NOW_MS);
    expect(d?.evidence).toContain('10/18');
    expect(d?.evidence.length).toBeLessThanOrEqual(EVIDENCE_MAX);
    expect(d?.evidence.startsWith('…')).toBe(true);
    expect(d?.evidence.endsWith('…')).toBe(true);
  });

  it('caps the result count and deduplicates identical instants', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Report due 10/${i + 1}`).join('\n');
    expect(findDeadlines(many, NOW_MS, { max: 5 })).toHaveLength(5);
    expect(jst('Due 10/18 ... and again due 10/18')).toEqual(['2026-10-18T23:59']);
  });

  it('skips dates before `from` before counting, so past dates never take a slot', () => {
    const dates = ['10/1', '10/3', '10/5', '10/8', '10/10', '10/20', '10/27'];
    const text = dates.map((d) => `Report due ${d}`).join('\n');
    const upcoming = findDeadlines(text, NOW_MS, { max: 4, from: NOW_MS - DAY }).map((d) => isoJst(d.ms).slice(5, 10));
    expect(upcoming).toEqual(['10-20', '10-27']);
    expect(findDeadlines(text, NOW_MS, { max: 4 })).toHaveLength(4); // without `from` past dates count
  });

  it('keeps the nearest candidates, in order of appearance, when more than `max` remain', () => {
    const text = ['Report due 11/30', 'Report due 10/22', 'Report due 10/16', 'Report due 12/10'].join('\n');
    const kept = findDeadlines(text, NOW_MS, { max: 2, from: NOW_MS }).map((d) => isoJst(d.ms).slice(5, 10));
    expect(kept).toEqual(['10-22', '10-16']);
  });

  it('handles 200 KB of text fast (no backtracking blow-up)', () => {
    const para = 'Week 1: 1/2 of the class, see 10/12 Introduction. Report due on 10/18 at 23:59. ３／４ 10月15日 ';
    const text = para.repeat(Math.ceil(200_000 / para.length));
    const adversarial = `${'1/'.repeat(50_000)}${'9'.repeat(50_000)}${'Oct '.repeat(20_000)}`;
    const t0 = performance.now();
    findDeadlines(text, NOW_MS);
    findDeadlines(adversarial, NOW_MS);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('formats like the rest of the app', () => {
    const [d] = findDeadlines('Due 10/18 12:00', NOW_MS);
    expect(fmt(isoJst(d?.ms ?? 0))).toBe('2026-10-18 Sun 12:00');
  });
});

describe('findDeadlines lead phrase', () => {
  const lead = (text: string) => findDeadlines(text, NOW_MS)[0]?.lead;

  it('takes the words before the date, cut at the sentence start', () => {
    expect(lead('課題の説明。課題の提出 10月20日 までです')).toBe('課題の提出');
    expect(lead('Intro line\nFinal report due on 10/18')).toBe('Final report');
    expect(lead('- **Hand in memo** by 10/21 12:00')).toBe('Hand in memo');
  });

  it('is at most 30 characters and never starts mid-word', () => {
    const l = lead('Please remember the extraordinarily important report due on 10/18') ?? '';
    expect(l.length).toBeLessThanOrEqual(30);
    expect(l).toBe('important report');
  });

  it('is empty when the date opens the sentence', () => {
    expect(lead('10月15日（木）23：59までに提出してください')).toBe('');
    expect(lead('Due: 10/18')).toBe('');
  });
});
