import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  academicYear,
  currentTerms,
  inCurrentTerm,
  lookupSeenCourses,
  lookupTerms,
  parseSyllabusTerm,
  type SyllabusInfo,
  syllabusPKey,
  termFit,
} from '../../src/core/services/syllabus';
import { parseSchedule } from '../../src/core/services/syllabus-schedule';
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
      slots: [{ weekday: 1, periodFrom: 1, periodTo: 2, night: false, classroom: null, campus: null }],
      onDemand: false,
      scheduleUnparsed: false,
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

  it('termFit: a term stays current for 14 days after it ends (final reports are swept after the last class)', () => {
    expect(termFit('秋クォーター', at('2026-11-21'))).toBe('current');
    expect(termFit('秋クォーター', at('2026-11-22'))).toBe('current'); // 冬クォーター has begun
    expect(termFit('秋クォーター', at('2026-12-05'))).toBe('current');
    expect(termFit('秋クォーター', at('2026-12-06'))).toBe('not-current');
    expect(termFit('秋クォーター', at('2026-11-22'), 2026)).toBe('current');
    expect(termFit('秋クォーター', at('2026-11-22'), 2025)).toBe('not-current');
    expect(termFit('春クォーター', at('2026-06-17'))).toBe('current'); // 6/3 + 14 days
    expect(termFit('春クォーター', at('2026-06-18'))).toBe('not-current');
  });

  it('a `／`-joined term list fits when any of its terms does', () => {
    expect(inCurrentTerm('春学期／秋学期', NOW.getTime())).toBe(true);
    expect(inCurrentTerm('春クォーター／夏クォーター', NOW.getTime())).toBe(false);
    expect(termFit('春学期／秋学期', NOW.getTime(), 2026)).toBe('current');
    expect(termFit('春学期／秋学期', NOW.getTime(), 2025)).toBe('not-current');
    expect(termFit('春クォーター／夏クォーター', NOW.getTime())).toBe('not-current');
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
      slots: [{ weekday: 1, periodFrom: 1, periodTo: 2, night: false, classroom: null, campus: null }],
      onDemand: false,
      scheduleUnparsed: false,
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
      slots: [],
      scheduleUnparsed: false,
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
      slots: [],
      scheduleUnparsed: false,
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
      slots: [],
      scheduleUnparsed: false,
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

// ------------------------------------------------------------------ schedule (slots, rooms, on-demand)

const slot = (
  weekday: number,
  periodFrom: number,
  periodTo: number,
  extra: Partial<Parameters<typeof expectSlot>[0]> = {},
) => expectSlot({ weekday, periodFrom, periodTo, ...extra });
function expectSlot(s: {
  weekday: number;
  periodFrom: number;
  periodTo: number;
  night?: boolean;
  classroom?: string | null;
  campus?: string | null;
}) {
  return { night: false, classroom: null, campus: null, ...s };
}

describe('parseSchedule', () => {
  it.each([
    ['月１-２', [slot(1, 1, 2)]],
    ['火４時限', [slot(2, 4, 4)]],
    ['土５-６', [slot(6, 5, 6)]],
    ['木夜６-７', [slot(4, 6, 7, { night: true })]],
    ['金夜６時限', [slot(5, 6, 6, { night: true })]],
    ['Thur.6-7(evening)', [slot(4, 6, 7, { night: true })]],
    ['Mon.1-2', [slot(1, 1, 2)]],
    ['Tues.3', [slot(2, 3, 3)]],
    ['01:月１時限／02:水１時限', [slot(1, 1, 1), slot(3, 1, 1)]],
    ['月３時限/木３時限', [slot(1, 3, 3), slot(4, 3, 3)]],
    ['01:金３-４ 02:水３時限', [slot(5, 3, 4), slot(3, 3, 3)]],
  ])('reads %s', (text, slots) => {
    expect(parseSchedule({ dayPeriod: text })).toEqual({ slots, onDemand: false, scheduleUnparsed: false });
  });

  it('keeps the meeting of a hybrid and flags on-demand', () => {
    expect(parseSchedule({ dayPeriod: '01:無フルOD／02:金１-２' })).toEqual({
      slots: [slot(5, 1, 2)],
      onDemand: true,
      scheduleUnparsed: false,
    });
    expect(parseSchedule({ dayPeriod: '無フルOD' })).toEqual({ slots: [], onDemand: true, scheduleUnparsed: false });
    expect(parseSchedule({ dayPeriod: 'On demand' })).toEqual({ slots: [], onDemand: true, scheduleUnparsed: false });
    expect(parseSchedule({ dayPeriod: '01:無フルOD／02:火２時限／03:木１-２／04:無フルOD' })).toMatchObject({
      slots: [slot(2, 2, 2), slot(4, 1, 2)],
      onDemand: true,
    });
  });

  it('has no slot, and nothing to doubt, for 無その他 and empty cells', () => {
    for (const text of ['無その他', 'その他', 'othersothers', '', null]) {
      expect(parseSchedule({ dayPeriod: text })).toEqual({ slots: [], onDemand: false, scheduleUnparsed: false });
    }
  });

  it('flags unreadable parts as unparsed instead of treating them like 無その他', () => {
    for (const text of ['月9時限', '月3-2', '随時 無', '月１・３', '01:月１時限／02:随時']) {
      expect(parseSchedule({ dayPeriod: text }).scheduleUnparsed).toBe(true);
    }
    expect(parseSchedule({ dayPeriod: '月１時限／随時' })).toMatchObject({
      slots: [slot(1, 1, 1)],
      scheduleUnparsed: true,
    });
  });

  it('reads １・２ as a range of consecutive periods and ignores a (隔週) suffix', () => {
    expect(parseSchedule({ dayPeriod: '月１・２' })).toEqual({
      slots: [slot(1, 1, 2)],
      onDemand: false,
      scheduleUnparsed: false,
    });
    expect(parseSchedule({ dayPeriod: '火３時限（隔週）' })).toMatchObject({
      slots: [slot(2, 3, 3)],
      scheduleUnparsed: false,
    });
    expect(parseSchedule({ dayPeriod: '01:木１-２(隔週)／02:金３時限' })).toMatchObject({
      slots: [slot(4, 1, 2), slot(5, 3, 3)],
      scheduleUnparsed: false,
    });
  });

  it('zips the classroom by slot number, or uses the only room, and adds the campus', () => {
    expect(
      parseSchedule({
        dayPeriod: '01:金３-４／02:水３時限',
        classroom: '01:２２-２０８／02:２２-７１９',
        campus: '早稲田',
      }).slots,
    ).toEqual([
      slot(5, 3, 4, { classroom: '22-208', campus: '早稲田' }),
      slot(3, 3, 3, { classroom: '22-719', campus: '早稲田' }),
    ]);
    // the OD part has no room: the number, not the position among meetings, picks the room
    expect(parseSchedule({ dayPeriod: '01:無フルOD／02:金１-２', classroom: '02:３-２０３' }).slots).toEqual([
      slot(5, 1, 2, { classroom: '3-203' }),
    ]);
    expect(parseSchedule({ dayPeriod: '月１時限／木１時限', classroom: '１１-９０９（馬蹄形）' }).slots).toEqual([
      slot(1, 1, 1, { classroom: '11-909(馬蹄形)' }),
      slot(4, 1, 1, { classroom: '11-909(馬蹄形)' }),
    ]);
    expect(parseSchedule({ dayPeriod: '火２時限', classroom: '教室未定', campus: '' }).slots).toEqual([slot(2, 2, 2)]);
  });

  it('uses the single-room fallback only for a room without a slot number', () => {
    // `01:22-208` belongs to slot 01 alone
    expect(parseSchedule({ dayPeriod: '01:金３-４／02:水３時限', classroom: '01:２２-２０８' }).slots).toEqual([
      slot(5, 3, 4, { classroom: '22-208' }),
      slot(3, 3, 3),
    ]);
    expect(parseSchedule({ dayPeriod: '01:金３-４／02:水３時限', classroom: '２２-２０８' }).slots).toEqual([
      slot(5, 3, 4, { classroom: '22-208' }),
      slot(3, 3, 3, { classroom: '22-208' }),
    ]);
  });
});

describe('parseSyllabusTerm (schedule cells)', () => {
  const full = (term: string, room: string, campus: string) =>
    `<html><body><table>${row('学期曜日時限', term)}${row('使用教室', room)}${row('キャンパス', campus)}</table></body></html>`;

  it('reads night slots with room and campus', () => {
    const parsed = parseSyllabusTerm(full('秋クォーター&nbsp;&nbsp;木夜６-７', '１１-９０９（馬蹄形）', '早稲田'));
    expect(parsed).toMatchObject({
      status: 'ok',
      term: '秋クォーター',
      onDemand: false,
      slots: [slot(4, 6, 7, { night: true, classroom: '11-909(馬蹄形)', campus: '早稲田' })],
    });
  });

  it('reads a multi-slot cell and an empty room cell (&nbsp;)', () => {
    const parsed = parseSyllabusTerm(full('秋学期&nbsp;&nbsp;01:無フルOD／02:金１-２', '&nbsp;', '早稲田'));
    expect(parsed).toMatchObject({ onDemand: true, slots: [slot(5, 1, 2, { campus: '早稲田' })] });
  });

  it('reads the <BR>-separated search-row form', () => {
    const parsed = parseSyllabusTerm(
      full('秋学期&nbsp;&nbsp;01:金３-４<BR>02:水３時限', '01:２２-２０８<BR>02:２２-７１９', '早稲田'),
    );
    expect(parsed).toMatchObject({
      slots: [
        slot(5, 3, 4, { classroom: '22-208', campus: '早稲田' }),
        slot(3, 3, 3, { classroom: '22-719', campus: '早稲田' }),
      ],
    });
  });

  it('reads a `／`-joined term list as one term string and keeps the meeting', () => {
    const parsed = parseSyllabusTerm(page('春学期／秋学期&nbsp;&nbsp;月１時限'));
    expect(parsed).toMatchObject({ term: '春学期／秋学期', dayPeriod: '月１時限', slots: [slot(1, 1, 1)] });
    expect(parseSyllabusTerm(page('春クォーター／夏クォーター&nbsp;&nbsp;01:月１時限／02:水１時限'))).toMatchObject({
      term: '春クォーター／夏クォーター',
      slots: [slot(1, 1, 1), slot(3, 1, 1)],
    });
    expect(parseSyllabusTerm(page('春学期／秋学期'))).toMatchObject({ term: '春学期／秋学期', dayPeriod: null });
  });

  it('exposes a cell whose time it does not understand as scheduleUnparsed', () => {
    const unknown = parseSyllabusTerm(page('秋学期&nbsp;&nbsp;月１時限・隔日'));
    expect(unknown).toMatchObject({ slots: [], scheduleUnparsed: true });
    const intensive = parseSyllabusTerm(page('集中講義（秋学期）&nbsp;&nbsp;無その他'));
    expect(intensive).toMatchObject({ scheduleUnparsed: false });
  });

  it('treats 集中講義（秋学期） as the intensive term with no slot', () => {
    expect(parseSyllabusTerm(page('集中講義（秋学期）&nbsp;&nbsp;無その他'))).toMatchObject({
      term: '集中',
      dayPeriod: '無その他',
      slots: [],
      onDemand: false,
      scheduleUnparsed: false,
    });
  });
});

describe('syllabus cache schema', () => {
  it('re-parses a pre-schedule row for use and fetches it again, keeping the old answer when the site fails', async () => {
    const t = makeFakeContext();
    const legacy = { pKey: PK1, year: 2026, term: '秋クォーター', dayPeriod: '月１-２', instructors: [] };
    t.state.syllabusCache.set(C1.idnumber, { json: JSON.stringify(legacy), fetchedAt: NOW.getTime() - DAY });
    const fetchFn = stubFetch({}, 503);
    const res = await lookupTerms(t.ctx, [C1]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(res.get(1)?.slots).toEqual([slot(1, 1, 2)]);
  });

  it('replaces a pre-schedule row by the freshly fetched one', async () => {
    const t = makeFakeContext();
    const legacy = { pKey: PK1, year: 2026, term: '秋クォーター', dayPeriod: '月１-２', instructors: [] };
    t.state.syllabusCache.set(C1.idnumber, { json: JSON.stringify(legacy), fetchedAt: NOW.getTime() - DAY });
    stubFetch({ [PK1]: page('秋クォーター&nbsp;&nbsp;月３時限') });
    await lookupTerms(t.ctx, [C1]);
    expect(JSON.parse(t.state.syllabusCache.get(C1.idnumber)?.json ?? '')).toMatchObject({
      slots: [slot(1, 3, 3)],
    });
  });
});

describe('syllabus cache: failures and fetch order', () => {
  const known: SyllabusInfo = {
    pKey: PK1,
    year: 2026,
    term: '秋クォーター',
    dayPeriod: '月１-２',
    instructors: [],
    slots: [slot(1, 1, 2, { classroom: '11-909', campus: '早稲田' })],
    onDemand: false,
    scheduleUnparsed: false,
  };
  const stored = (t: ReturnType<typeof makeFakeContext>) => {
    const row = t.state.syllabusCache.get(C1.idnumber);
    return { json: JSON.parse(row?.json ?? 'null'), fetchedAt: row?.fetchedAt };
  };

  it('a failed re-fetch keeps the previous answer next to the marker, serves it and backs off for an hour', async () => {
    const t = makeFakeContext();
    t.state.syllabusCache.set(C1.idnumber, { json: JSON.stringify(known), fetchedAt: NOW.getTime() - 400 * DAY });
    const fetchFn = stubFetch({}, 503);

    expect((await lookupTerms(t.ctx, [C1])).get(1)).toEqual(known);
    expect(stored(t)).toEqual({ json: { unknown: true, prev: known }, fetchedAt: NOW.getTime() });

    expect((await lookupTerms(t.ctx, [C1])).get(1)).toEqual(known); // within the hour: no new request
    expect(fetchFn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000)); // asked again, fails again: still kept
    expect((await lookupTerms(t.ctx, [C1])).get(1)).toEqual(known);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(stored(t).json).toEqual({ unknown: true, prev: known });
  });

  it('a later successful fetch replaces the marker and its previous answer', async () => {
    const t = makeFakeContext();
    const marker = { unknown: true, prev: known };
    t.state.syllabusCache.set(C1.idnumber, { json: JSON.stringify(marker), fetchedAt: NOW.getTime() - 2 * 3_600_000 });
    stubFetch({ [PK1]: page('冬クォーター&nbsp;&nbsp;木１-２') });
    expect((await lookupTerms(t.ctx, [C1])).get(1)?.term).toBe('冬クォーター');
    expect(stored(t).json).toMatchObject({ term: '冬クォーター' });
    expect(stored(t).json.unknown).toBeUndefined();
  });

  it('a failed fetch of a course without a stored answer stores the bare marker', async () => {
    const t = makeFakeContext();
    stubFetch({}, 503);
    await lookupTerms(t.ctx, [C1]);
    expect(stored(t).json).toEqual({ unknown: true });
  });

  it('refetches a pre-scheduleUnparsed row of the current academic year, not of another year', async () => {
    const t = makeFakeContext();
    const { scheduleUnparsed: _dropped, ...v2 } = { ...known, term: '春学期', slots: [] };
    const other = course(9, '2025570010006209');
    const v1 = { pKey: 'k', year: 2025, term: '秋クォーター', dayPeriod: '月１-２', instructors: [] };
    t.state.syllabusCache.set(C1.idnumber, { json: JSON.stringify(v2), fetchedAt: NOW.getTime() - DAY });
    t.state.syllabusCache.set(other.idnumber, { json: JSON.stringify(v1), fetchedAt: NOW.getTime() - DAY });
    const fetchFn = stubFetch({ [PK1]: page('春学期／秋学期&nbsp;&nbsp;月１-２') });

    const res = await lookupTerms(t.ctx, [other, C1]);
    expect(fetchFn).toHaveBeenCalledTimes(1); // only the current year's row
    expect(res.get(1)?.term).toBe('春学期／秋学期');
    expect(res.get(9)?.slots).toEqual([slot(1, 1, 2)]); // the other year's v1 row: term (and re-parsed slots) will do
  });

  const fetchedKeys = (fetchFn: ReturnType<typeof stubFetch>) =>
    fetchFn.mock.calls.map(([url]) => new URL(url).searchParams.get('pKey'));
  const idnumbers = [
    '2025570010006201',
    '2025570010006202',
    '2026570010006203',
    '2026570010006204',
    '2025570010006205',
  ];
  const list = idnumbers.map((idnumber, i) => course(i + 1, idnumber));

  it('fetches the confirmed courses first, then the current academic year, in Moodle order', async () => {
    const fetchFn = stubFetch({});
    const t = makeFakeContext({ user: { settings: { myCourseIds: [5] } } });
    await lookupTerms(t.ctx, list);
    expect(fetchedKeys(fetchFn)).toEqual([5, 3, 4].map((n) => syllabusPKey(idnumbers[n - 1] ?? '')));
  });

  it('without a confirmed selection the current academic year goes first', async () => {
    const fetchFn = stubFetch({});
    await lookupTerms(makeFakeContext().ctx, list);
    expect(fetchedKeys(fetchFn)).toEqual([3, 4, 1].map((n) => syllabusPKey(idnumbers[n - 1] ?? '')));
  });
});

describe('lookupSeenCourses', () => {
  const courses = [1, 2, 3, 4, 5].map((n) => course(n, `202657001000620${n}`));

  it('serves the courses an earlier lookup of the request presented, within the request fetch budget', async () => {
    const fetchFn = vi.fn(async () => new Response(page('秋学期&nbsp;&nbsp;月１時限')));
    vi.stubGlobal('fetch', fetchFn);
    const t = makeFakeContext();
    await lookupTerms(t.ctx, courses); // the course scope: 3 of 5 fetched
    expect(fetchFn).toHaveBeenCalledTimes(3);

    const res = await lookupSeenCourses(t.ctx, [1, 4, 5, 99]);
    expect(fetchFn).toHaveBeenCalledTimes(3); // budget of the request is used up
    expect(res.get(1)?.slots).toEqual([slot(1, 1, 1)]);
    expect(res.get(4)).toBeNull();
    expect(res.has(99)).toBe(false); // never presented: nothing to look up
  });

  it('a new request (context) has its own list of presented courses and its own budget', async () => {
    const fetchFn = vi.fn(async () => new Response(page('秋学期&nbsp;&nbsp;月１時限')));
    vi.stubGlobal('fetch', fetchFn);
    const first = makeFakeContext();
    await lookupTerms(first.ctx, courses);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const second = makeFakeContext();
    second.state.syllabusCache = first.state.syllabusCache;
    expect((await lookupSeenCourses(second.ctx, [4])).size).toBe(0);
    await lookupTerms(second.ctx, courses);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('does not fetch when the presenting lookup was cache-only', async () => {
    const fetchFn = stubFetch({});
    const t = makeFakeContext();
    await lookupTerms(t.ctx, courses, { syllabusLookup: false });
    await lookupSeenCourses(t.ctx, [1, 2]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
