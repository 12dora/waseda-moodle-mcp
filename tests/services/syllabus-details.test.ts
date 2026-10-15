import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, NotFound } from '../../src/core/errors';
import { DETAIL_URL, syllabusPKey } from '../../src/core/services/syllabus';
import { getSyllabusDetails } from '../../src/core/services/syllabus-details';
import { parseSyllabusPage } from '../../src/core/services/syllabus-page';
import { EMPTY_PAGE, EN_PAGE, ERROR_PAGE, JA_PAGE } from '../fixtures/syllabus';
import { makeFakeContext } from '../helpers/fake-context';

const NOW = new Date('2026-10-14T03:00:00Z'); // 2026-10-14 12:00 JST
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ID_CLASS = '2026570010006202';
const ID_OTHER = '2020ZZT900001408';
const ID_NO_PAGE = '2026570010009999';
const PKEY = syllabusPKey(ID_CLASS) ?? '';
const PKEY_NO_PAGE = syllabusPKey(ID_NO_PAGE) ?? '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ fakes

type Reply = { status?: number; body?: string } | Error;

/** The public site: `handler(pKey, pLng)` answers every GET; returns the log of `pKey:pLng` requests. */
function stubSite(handler: (pKey: string, pLng: string) => Reply): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const pKey = url.searchParams.get('pKey') ?? '';
      const pLng = url.searchParams.get('pLng') ?? '';
      calls.push(`${pKey}:${pLng}`);
      const reply = handler(pKey, pLng);
      if (reply instanceof Error) throw reply;
      return new Response(reply.body ?? '', { status: reply.status ?? 200 });
    }),
  );
  return calls;
}

const raw = (id: number, idnumber: string) => ({ id, fullname: `Course ${id}`, shortname: `C${id}`, idnumber });

function setup(lang = 'ja') {
  return makeFakeContext({
    user: { lang },
    responses: {
      core_course_get_enrolled_courses_by_timeline_classification: {
        courses: [raw(1, ID_CLASS), raw(2, ID_OTHER), raw(3, ID_NO_PAGE)],
      },
      core_enrol_get_users_courses: [],
      core_calendar_get_action_events_by_timesort: { events: [] },
    },
  });
}

/** ja page for the class course, English page when `en`, the site's "no syllabus" page for everything else. */
const site =
  (en: Reply = { body: EN_PAGE }) =>
  (pKey: string, pLng: string) => {
    if (pKey !== PKEY) return { body: EMPTY_PAGE };
    return pLng === 'en' ? en : { body: JA_PAGE };
  };

const storedOf = (t: ReturnType<typeof setup>, key: string) =>
  JSON.parse(t.state.syllabusCache.get(key)?.json ?? 'null');

// ------------------------------------------------------------------ tests

describe('getSyllabusDetails', () => {
  it('fetches the Japanese page, parses it and caches it under d:<idnumber>', async () => {
    const calls = stubSite(site());
    const t = setup();
    const d = await getSyllabusDetails(t.ctx, 1);
    expect(d).toMatchObject({
      courseId: 1,
      courseName: 'Course 1',
      status: 'ok',
      requestedLang: 'ja',
      url: `${DETAIL_URL}?pKey=${PKEY}&pLng=jp`,
    });
    expect(d.page).toMatchObject({ lang: 'ja', title: 'サンプル経営論' });
    expect(d.page?.grading).toHaveLength(2);
    expect(calls).not.toContain(`${PKEY}:en`);
    expect(storedOf(t, `d:${ID_CLASS}`)).toMatchObject({ v: 1, page: { title: 'サンプル経営論' } });
    expect(t.state.syllabusCache.get(`d:${ID_CLASS}`)?.fetchedAt).toBe(NOW.getTime());

    const asked = calls.length;
    expect((await getSyllabusDetails(t.ctx, 1)).page?.title).toBe('サンプル経営論');
    expect(calls).toHaveLength(asked); // second call is served from the cache
  });

  it('asks for the English page when the Moodle language is English, under its own cache key', async () => {
    const calls = stubSite(site());
    const t = setup('en');
    const d = await getSyllabusDetails(t.ctx, 1);
    expect(d).toMatchObject({ status: 'ok', requestedLang: 'en', url: `${DETAIL_URL}?pKey=${PKEY}&pLng=en` });
    expect(d.page).toMatchObject({ lang: 'en', title: 'Sample Strategy' });
    expect(calls).toContain(`${PKEY}:en`);
    expect(t.state.syllabusCache.has(`d:${ID_CLASS}:en`)).toBe(true);
    expect(t.state.syllabusCache.has(`d:${ID_CLASS}`)).toBe(false);
  });

  it('falls back to the Japanese page when there is no English one, and remembers that', async () => {
    const calls = stubSite(site({ body: EMPTY_PAGE }));
    const t = setup('en-US');
    const d = await getSyllabusDetails(t.ctx, 1);
    expect(d).toMatchObject({ status: 'ok', requestedLang: 'en' });
    expect(d.page?.lang).toBe('ja');
    expect(d.url).toBe(`${DETAIL_URL}?pKey=${PKEY}&pLng=jp`);
    expect(storedOf(t, `d:${ID_CLASS}:en`)).toEqual({ v: 1, page: null });

    const asked = calls.length;
    expect((await getSyllabusDetails(t.ctx, 1)).page?.lang).toBe('ja');
    expect(calls).toHaveLength(asked);
  });

  it('falls back to Japanese when the English page fails, without asking again within the hour', async () => {
    const calls = stubSite(site({ status: 503 }));
    const t = setup('en');
    expect((await getSyllabusDetails(t.ctx, 1)).page?.lang).toBe('ja');
    expect(storedOf(t, `d:${ID_CLASS}:en`)).toEqual({ unknown: true });

    const asked = calls.length;
    await getSyllabusDetails(t.ctx, 1);
    expect(calls).toHaveLength(asked);
  });

  it('says there is no per-class page for a course the site has none for (and caches "none")', async () => {
    const calls = stubSite(site());
    const t = setup();
    const d = await getSyllabusDetails(t.ctx, 3);
    expect(d).toMatchObject({ status: 'no-page', page: null, url: null });
    expect(d.searchUrl).toBe('https://www.wsl.waseda.jp/syllabus/index.php');
    expect(storedOf(t, `d:${ID_NO_PAGE}`)).toEqual({ v: 1, page: null });

    const asked = calls.length;
    expect((await getSyllabusDetails(t.ctx, 3)).status).toBe('no-page');
    expect(calls).toHaveLength(asked);
    expect(calls).toContain(`${PKEY_NO_PAGE}:jp`);
  });

  it('does not ask the site about non-class courses', async () => {
    const calls = stubSite(site());
    const t = setup();
    const d = await getSyllabusDetails(t.ctx, 2);
    expect(d).toMatchObject({ status: 'not-a-class', page: null, url: null });
    expect(calls.every((c) => !c.includes('ZZ'))).toBe(true);
    expect([...t.state.syllabusCache.keys()].filter((k) => k.startsWith('d:'))).toEqual([]);
  });

  it('reports a failing site as unavailable, backs off for an hour, then retries', async () => {
    let reply: Reply = { status: 500 };
    const calls = stubSite((pKey) => (pKey === PKEY ? reply : { body: EMPTY_PAGE }));
    const t = setup();
    const down = await getSyllabusDetails(t.ctx, 1);
    expect(down).toMatchObject({ status: 'unavailable', page: null, url: `${DETAIL_URL}?pKey=${PKEY}&pLng=jp` });
    expect(storedOf(t, `d:${ID_CLASS}`)).toEqual({ unknown: true });

    const asked = calls.length;
    await getSyllabusDetails(t.ctx, 1);
    expect(calls).toHaveLength(asked); // backing off

    reply = { body: JA_PAGE };
    vi.setSystemTime(NOW.getTime() + 2 * HOUR);
    expect((await getSyllabusDetails(t.ctx, 1)).status).toBe('ok');
    expect(storedOf(t, `d:${ID_CLASS}`)).toMatchObject({ v: 1 });
  });

  it('keeps an expired page beside the failure marker and serves it while the marker is fresh', async () => {
    let reply: Reply = { status: 503 };
    const calls = stubSite((pKey) => (pKey === PKEY ? reply : { body: EMPTY_PAGE }));
    const page = parseSyllabusPage(JA_PAGE, 'ja');
    const t = setup();
    t.state.syllabusCache.set(`d:${ID_CLASS}`, {
      json: JSON.stringify({ v: 1, page }),
      fetchedAt: NOW.getTime() - 31 * DAY,
    });
    const d = await getSyllabusDetails(t.ctx, 1);
    expect(d).toMatchObject({ status: 'ok', url: `${DETAIL_URL}?pKey=${PKEY}&pLng=jp` });
    expect(d.page?.title).toBe('サンプル経営論');
    expect(storedOf(t, `d:${ID_CLASS}`)).toMatchObject({
      unknown: true,
      prev: { v: 1, page: { title: 'サンプル経営論' } },
    });

    const asked = calls.length;
    expect((await getSyllabusDetails(t.ctx, 1)).page?.title).toBe('サンプル経営論');
    expect(calls).toHaveLength(asked); // backing off, still served

    vi.setSystemTime(NOW.getTime() + 2 * HOUR); // marker expired, site still down: the page survives another round
    expect((await getSyllabusDetails(t.ctx, 1)).page?.title).toBe('サンプル経営論');
    expect(storedOf(t, `d:${ID_CLASS}`).prev.page.title).toBe('サンプル経営論');

    reply = { body: JA_PAGE.replace('サンプル経営論', '新しい題名') };
    vi.setSystemTime(NOW.getTime() + 4 * HOUR);
    expect((await getSyllabusDetails(t.ctx, 1)).page?.title).toBe('新しい題名');
    expect(storedOf(t, `d:${ID_CLASS}`)).toMatchObject({ v: 1 });
  });

  it('treats a network error and an unrecognised page as failures, not as "no page"', async () => {
    stubSite(() => new Error('network down'));
    expect((await getSyllabusDetails(setup().ctx, 1)).status).toBe('unavailable');
    stubSite(() => ({ body: ERROR_PAGE }));
    const t = setup();
    expect((await getSyllabusDetails(t.ctx, 1)).status).toBe('unavailable');
    expect(storedOf(t, `d:${ID_CLASS}`)).toEqual({ unknown: true });
  });

  it('refetches a page older than 30 days and a row of an older cache version', async () => {
    stubSite(site());
    const old = { ...parseSyllabusPage(JA_PAGE, 'ja'), title: 'OLD' };
    const t = setup();
    t.state.syllabusCache.set(`d:${ID_CLASS}`, {
      json: JSON.stringify({ v: 1, page: old }),
      fetchedAt: NOW.getTime() - 30 * DAY,
    });
    expect((await getSyllabusDetails(t.ctx, 1)).page?.title).toBe('サンプル経営論');

    const t2 = setup();
    t2.state.syllabusCache.set(`d:${ID_CLASS}`, {
      json: JSON.stringify({ v: 0, page: old }),
      fetchedAt: NOW.getTime(),
    });
    expect((await getSyllabusDetails(t2.ctx, 1)).page?.title).toBe('サンプル経営論');
  });

  it('serves a fresh cached page without any request', async () => {
    const calls = stubSite(site());
    const page = parseSyllabusPage(JA_PAGE, 'ja');
    const t = setup();
    t.ctx.syllabusLookup = false; // kill switch: the term lookup of the scope is off too
    t.state.syllabusCache.set(`d:${ID_CLASS}`, {
      json: JSON.stringify({ v: 1, page }),
      fetchedAt: NOW.getTime() - 29 * DAY,
    });
    expect((await getSyllabusDetails(t.ctx, 1)).page?.title).toBe('サンプル経営論');
    expect(calls).toEqual([]);
  });

  it('with the kill switch on and nothing cached it reports "disabled" and fetches nothing', async () => {
    const calls = stubSite(site());
    const t = setup();
    t.ctx.syllabusLookup = false;
    expect(await getSyllabusDetails(t.ctx, 1)).toMatchObject({ status: 'disabled', page: null });
    expect(calls).toEqual([]);
  });

  it('survives an unreadable or failing cache', async () => {
    stubSite(site());
    const t = setup();
    t.state.syllabusCache.set(`d:${ID_CLASS}`, { json: '{not json', fetchedAt: NOW.getTime() });
    const putSyllabusCache = vi.spyOn(t.store, 'putSyllabusCache').mockRejectedValue(new Error('d1 down'));
    expect((await getSyllabusDetails(t.ctx, 1)).status).toBe('ok');
    expect(putSyllabusCache).toHaveBeenCalled();
  });

  it('rejects a course the user is not enrolled in and an invalid id', async () => {
    stubSite(site());
    const t = setup();
    await expect(getSyllabusDetails(t.ctx, 99)).rejects.toBeInstanceOf(NotFound);
    await expect(getSyllabusDetails(t.ctx, 0)).rejects.toBeInstanceOf(InvalidInput);
  });
});
