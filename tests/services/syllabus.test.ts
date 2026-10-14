import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  academicYear,
  currentTerms,
  inCurrentTerm,
  lookupTerms,
  parseSyllabusTerm,
  type SyllabusInfo,
  syllabusPKey,
  termFit,
} from '../../src/core/services/syllabus';
import { makeFakeContext } from '../helpers/fake-context';

const NOW = new Date('2026-10-14T03:00:00Z'); // 2026-10-14 12:00 JST
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T12:00:00+09:00`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ synthetic pages shaped like the public ones

const row = (label: string, value: string) =>
  `<tr><th width="12%" scope="row" colspan="2">${label}</th>\n<td colspan="5">${value}</td></tr>`;
const page = (term: string, teachers = 'Yamada Taro') =>
  `<html><body><table>${row('担当教員', teachers)}${row('学期曜日時限', term)}</table></body></html>`;
const EMPTY_PAGE = '<html><body><p>参照可能なシラバス情報はありません。</p></body></html>';
const ERROR_PAGE = '<html><body><h1>システムエラー</h1></body></html>';

describe('syllabusPKey', () => {
  it('builds courseKey + classCode + year + courseKey + school for ordinary schools', () => {
    expect(syllabusPKey('2026570010006202')).toBe('5700100062022026570010006257');
    expect(syllabusPKey('2026570020004801')).toBe('5700200048012026570020004857');
    expect(syllabusPKey('20269204B5601502')).toBe('9204B560150220269204B5601592');
  });

  it('rewrites the second key copy to 26… for schools 27 and 28', () => {
    expect(syllabusPKey('202627M033100202')).toBe('27M033100202202626M033100227');
    expect(syllabusPKey('202628M033100202')).toBe('28M033100202202626M033100228');
  });

  it('is null for non-class and malformed idnumbers', () => {
    expect(syllabusPKey('2020ZZT900001408')).toBeNull();
    expect(syllabusPKey('X101')).toBeNull();
    expect(syllabusPKey('')).toBeNull();
    expect(syllabusPKey('2026570010006202X')).toBeNull();
  });
});

describe('parseSyllabusTerm', () => {
  it('reads term, day/period and instructors from the ja cells', () => {
    expect(parseSyllabusTerm(page('秋クォーター&nbsp;&nbsp;月１-２', 'Yamada Taro、Suzuki Hanako'))).toEqual({
      status: 'ok',
      term: '秋クォーター',
      dayPeriod: '月１-２',
      instructors: ['Yamada Taro', 'Suzuki Hanako'],
    });
    expect(parseSyllabusTerm(page('秋学期&nbsp;&nbsp;木３時限'))).toMatchObject({
      term: '秋学期',
      dayPeriod: '木３時限',
    });
  });

  it('copes with tags, entities and several sections in the cell', () => {
    const html = page('冬クォーター&nbsp;&nbsp;<span>01:月１時限／02:水１時限</span>');
    expect(parseSyllabusTerm(html)).toMatchObject({ term: '冬クォーター', dayPeriod: '01:月１時限／02:水１時限' });
    expect(parseSyllabusTerm(page('通年'))).toMatchObject({ term: '通年', dayPeriod: null });
  });

  it('keeps an unrecognised cell as day/period with no term', () => {
    expect(parseSyllabusTerm(page('随時&nbsp;&nbsp;無'))).toMatchObject({ term: null, dayPeriod: '随時 無' });
  });

  it('tells the empty page and the system error apart, and rejects anything else', () => {
    expect(parseSyllabusTerm(EMPTY_PAGE)).toEqual({ status: 'empty' });
    expect(parseSyllabusTerm(ERROR_PAGE)).toEqual({ status: 'error' });
    expect(parseSyllabusTerm('<html>maintenance</html>')).toEqual({ status: 'error' });
  });

  it('looks for the error marker only when the term cell is missing', () => {
    const real = page('秋クォーター&nbsp;&nbsp;月１-２').replace('Yamada Taro', 'システムエラー入門担当');
    expect(parseSyllabusTerm(`${real}<p>システムエラー</p>`)).toMatchObject({ status: 'ok', term: '秋クォーター' });
  });
});

describe('currentTerms / termFit', () => {
  it('follows the academic calendar', () => {
    expect([...currentTerms(at('2026-04-20'))].sort()).toEqual(['春クォーター', '春学期', '通年'].sort());
    expect([...currentTerms(at('2026-06-10'))].sort()).toEqual(['夏クォーター', '春学期', '通年'].sort());
    expect([...currentTerms(at('2026-10-14'))].sort()).toEqual(['秋クォーター', '秋学期', '通年'].sort());
    expect([...currentTerms(at('2026-09-25'))]).toContain('秋クォーター'); // semester has started, classes follow
    expect([...currentTerms(at('2026-11-21'))]).toContain('秋クォーター');
    expect([...currentTerms(at('2026-11-23'))].sort()).toEqual(['冬クォーター', '秋学期', '通年'].sort());
    expect([...currentTerms(at('2027-02-10'))]).toContain('冬クォーター'); // break before the spring term
  });

  it('applies the same month rules to other academic years', () => {
    expect(inCurrentTerm('秋クォーター', at('2027-10-14'))).toBe(true);
    expect(inCurrentTerm('冬クォーター', at('2027-10-14'))).toBe(false);
    expect(inCurrentTerm('春クォーター', at('2028-05-01'))).toBe(true);
    expect(inCurrentTerm(null, NOW.getTime())).toBe(false);
  });

  it('termFit: known current / known not current / unknown (no term, intensive)', () => {
    const now = NOW.getTime();
    expect(termFit('秋クォーター', now)).toBe('current');
    expect(termFit('通年', now)).toBe('current');
    expect(termFit('冬クォーター', now)).toBe('not-current');
    expect(termFit('春学期', now)).toBe('not-current');
    expect(termFit('集中', now)).toBe('unknown');
    expect(termFit(null, now)).toBe('unknown');
  });

  it('termFit: a term is current from 14 days before it starts', () => {
    expect(termFit('冬クォーター', at('2026-11-07'))).toBe('not-current');
    expect(termFit('冬クォーター', at('2026-11-10'))).toBe('current');
    expect(termFit('春クォーター', at('2027-03-20'))).toBe('current'); // spring term of the next academic year
    expect(termFit('春学期', at('2026-03-20'))).toBe('current');
    expect(termFit('夏クォーター', at('2026-05-21'))).toBe('current');
    expect(termFit('夏クォーター', at('2026-05-15'))).toBe('not-current');
  });

  it('termFit: the course academic year must be the current one (Jan-Mar belong to the previous year)', () => {
    expect(academicYear(at('2026-10-14'))).toBe(2026);
    expect(academicYear(at('2027-02-10'))).toBe(2026);
    expect(academicYear(at('2027-04-01'))).toBe(2027);
    expect(termFit('秋クォーター', at('2026-10-14'), 2026)).toBe('current');
    expect(termFit('秋クォーター', at('2026-10-14'), 2025)).toBe('not-current');
    expect(termFit('通年', at('2026-10-14'), 2025)).toBe('not-current');
    expect(termFit('冬クォーター', at('2027-02-10'), 2026)).toBe('current');
    expect(termFit('冬クォーター', at('2027-02-10'), 2027)).toBe('not-current');
    expect(termFit('通年', at('2027-03-25'), 2027)).toBe('current'); // 2027 begins within 14 days
    expect(termFit(null, at('2026-10-14'), 2020)).toBe('unknown');
  });
});

// ------------------------------------------------------------------ lookupTerms

function stubFetch(pages: Record<string, string | Error | number>, fallback: string | number = EMPTY_PAGE) {
  const fn = vi.fn(async (url: string) => {
    const key = new URL(url).searchParams.get('pKey') ?? '';
    const res = pages[key] ?? fallback;
    if (res instanceof Error) throw res;
    if (typeof res === 'number') return new Response('x', { status: res });
    return new Response(res, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const course = (id: number, idnumber: string) => ({ id, idnumber });
const C1 = course(1, '2026570010006202'); // pKey 5700100062022026570010006257
const C2 = course(2, '2026570020004801'); // pKey 5700200048012026570020004857
const PK1 = '5700100062022026570010006257';
const PK2 = '5700200048012026570020004857';

describe('lookupTerms', () => {
  it('fetches the detail page politely, parses it and caches the result globally', async () => {
    const fetchFn = stubFetch({ [PK1]: page('秋クォーター&nbsp;&nbsp;月１-２') });
    const t = makeFakeContext();
    const res = await lookupTerms(t.ctx, [C1]);
    expect(res.get(1)).toEqual({
      pKey: PK1,
      year: 2026,
      term: '秋クォーター',
      dayPeriod: '月１-２',
      instructors: ['Yamada Taro'],
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://www.wsl.waseda.jp/syllabus/JAA104.php?pKey=${PK1}&pLng=jp`);
    expect(init.headers).toEqual({
      'User-Agent': 'waseda-moodle-mcp/0.1 (+syllabus term lookup)',
      'Accept-Language': 'ja',
    });
    expect(t.state.syllabusCache.get(C1.idnumber)).toMatchObject({ fetchedAt: NOW.getTime() });
    expect(JSON.parse(t.state.syllabusCache.get(C1.idnumber)?.json ?? '')).toMatchObject({ term: '秋クォーター' });
  });

  it('serves fresh cache rows without fetching, including cached "no syllabus"', async () => {
    const fetchFn = stubFetch({});
    const t = makeFakeContext();
    const info: SyllabusInfo = {
      pKey: PK1,
      year: 2026,
      term: '冬クォーター',
      dayPeriod: null,
      instructors: [],
    };
    t.state.syllabusCache.set(C1.idnumber, { json: JSON.stringify(info), fetchedAt: NOW.getTime() - 30 * DAY });
    t.state.syllabusCache.set(C2.idnumber, { json: 'null', fetchedAt: NOW.getTime() - 30 * DAY });
    const res = await lookupTerms(t.ctx, [C1, C2]);
    expect(res.get(1)?.term).toBe('冬クォーター');
    expect(res.get(2)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('caches "no syllabus" (empty page) for the year', async () => {
    stubFetch({ [PK1]: EMPTY_PAGE });
    const t = makeFakeContext();
    expect([...(await lookupTerms(t.ctx, [C1])).values()]).toEqual([null]);
    expect(t.state.syllabusCache.get(C1.idnumber)?.json).toBe('null');
  });

  it('caches server errors, bad statuses and network failures as "unknown" for one hour', async () => {
    const fetchFn = stubFetch({ [PK1]: ERROR_PAGE, [PK2]: new Error('network down') }, 503);
    const t = makeFakeContext();
    const c3 = course(3, '2026570010009901');
    const res = await lookupTerms(t.ctx, [C1, C2, c3]);
    expect([...res.values()]).toEqual([null, null, null]);
    for (const c of [C1, C2, c3]) {
      expect(JSON.parse(t.state.syllabusCache.get(c.idnumber)?.json ?? '')).toEqual({ unknown: true });
    }
    expect(fetchFn).toHaveBeenCalledTimes(3);

    await lookupTerms(t.ctx, [C1, C2, c3]); // within the hour: nothing is asked again
    expect(fetchFn).toHaveBeenCalledTimes(3);

    vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
    await lookupTerms(t.ctx, [C1]);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('a later answer replaces the "unknown" marker', async () => {
    const t = makeFakeContext();
    t.state.syllabusCache.set(C1.idnumber, { json: '{"unknown":true}', fetchedAt: NOW.getTime() - 2 * 3_600_000 });
    stubFetch({ [PK1]: page('秋クォーター&nbsp;&nbsp;月１-２') });
    expect((await lookupTerms(t.ctx, [C1])).get(1)?.term).toBe('秋クォーター');
    expect(JSON.parse(t.state.syllabusCache.get(C1.idnumber)?.json ?? '')).toMatchObject({ term: '秋クォーター' });
  });

  it('one 3 s deadline covers all lookups of a call; courses not reached are not cached', async () => {
    const fetchFn = vi.fn(async () => {
      vi.setSystemTime(new Date(Date.now() + 3500)); // the first request hangs past the deadline
      throw new Error('timeout');
    });
    vi.stubGlobal('fetch', fetchFn);
    const t = makeFakeContext();
    const res = await lookupTerms(t.ctx, [C1, C2]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect([...res.values()]).toEqual([null, null]);
    expect(JSON.parse(t.state.syllabusCache.get(C1.idnumber)?.json ?? '')).toEqual({ unknown: true });
    expect(t.state.syllabusCache.has(C2.idnumber)).toBe(false);
  });

  it('passes the remaining time as the abort signal of each fetch', async () => {
    const fetchFn = stubFetch({ [PK1]: page('秋学期') });
    await lookupTerms(makeFakeContext().ctx, [C1]);
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('makes at most 3 fetches per call, one after the other', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return new Response(page('秋学期&nbsp;&nbsp;月１時限'));
    });
    vi.stubGlobal('fetch', fetchFn);
    const t = makeFakeContext();
    const courses = [1, 2, 3, 4, 5].map((n) => course(n, `202657001000620${n}`));
    const res = await lookupTerms(t.ctx, courses);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
    expect([...res.values()].map((i) => i?.term ?? null)).toEqual(['秋学期', '秋学期', '秋学期', null, null]);

    await lookupTerms(t.ctx, courses); // the next call catches up
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('refetches rows older than a year or cached for another year', async () => {
    const fetchFn = stubFetch({
      [PK1]: page('秋クォーター&nbsp;&nbsp;月１-２'),
      [PK2]: page('冬クォーター&nbsp;&nbsp;木１-２'),
    });
    const t = makeFakeContext();
    const stale: SyllabusInfo = {
      pKey: PK1,
      year: 2026,
      term: '春学期',
      dayPeriod: null,
      instructors: [],
    };
    t.state.syllabusCache.set(C1.idnumber, { json: JSON.stringify(stale), fetchedAt: NOW.getTime() - 400 * DAY });
    t.state.syllabusCache.set(C2.idnumber, {
      json: JSON.stringify({ ...stale, pKey: PK2, year: 2025 }),
      fetchedAt: NOW.getTime() - DAY,
    });
    const res = await lookupTerms(t.ctx, [C1, C2]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect([res.get(1)?.term, res.get(2)?.term]).toEqual(['秋クォーター', '冬クォーター']);
  });

  it('kill switch: no fetch, cached rows (even stale) still answer', async () => {
    const fetchFn = stubFetch({ [PK2]: page('秋学期') });
    const t = makeFakeContext();
    const info: SyllabusInfo = {
      pKey: PK1,
      year: 2026,
      term: '秋クォーター',
      dayPeriod: null,
      instructors: [],
    };
    t.state.syllabusCache.set(C1.idnumber, { json: JSON.stringify(info), fetchedAt: NOW.getTime() - 500 * DAY });
    const res = await lookupTerms(t.ctx, [C1, C2], { syllabusLookup: false });
    expect(res.get(1)?.term).toBe('秋クォーター');
    expect(res.get(2)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips non-class and malformed idnumbers without any request', async () => {
    const fetchFn = stubFetch({});
    const t = makeFakeContext();
    const res = await lookupTerms(t.ctx, [course(1, '2020ZZT900001408'), course(2, 'X101'), course(3, '')]);
    expect([...res.entries()]).toEqual([
      [1, null],
      [2, null],
      [3, null],
    ]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("leaves 総合日本語 sections without a page unknown: no master-page guess by today's season", async () => {
    const fetchFn = stubFetch({});
    const t = makeFakeContext();
    const res = await lookupTerms(t.ctx, [course(7, '2026920015500116')]);
    expect(res.get(7)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1); // only the section's own page
  });

  it('never throws, even when the cache store fails', async () => {
    stubFetch({ [PK1]: page('秋クォーター&nbsp;&nbsp;月１-２') });
    const t = makeFakeContext();
    vi.spyOn(t.store, 'getSyllabusCache').mockRejectedValue(new Error('d1 down'));
    vi.spyOn(t.store, 'putSyllabusCache').mockRejectedValue(new Error('d1 down'));
    expect((await lookupTerms(t.ctx, [C1])).get(1)?.term).toBe('秋クォーター');
  });
});
