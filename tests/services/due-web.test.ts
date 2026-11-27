import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoodleError } from '../../src/core/errors';
import { attachSubmissions } from '../../src/core/services/submission';
import { callBatch } from '../../src/core/services/submission/batch';
import type { DueItem } from '../../src/core/types';
import { makeFakeContext } from '../helpers/fake-context-be3';
import { fixture, makeWebApi, type WebApiOptions } from './web-channel';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'));
});
afterEach(() => {
  vi.useRealTimers();
});

function item(patch: Partial<DueItem>): DueItem {
  return {
    kind: 'assign',
    courseId: 99101,
    courseName: '総合日本語３Ｘ',
    cmid: 7201,
    name: 'レポート',
    opensAt: null,
    dueAt: '2026-10-12T23:59:00+09:00',
    midnightDue: false,
    overdue: false,
    closed: false,
    notOpenYet: false,
    url: 'https://wsdmoodle.waseda.jp/mod/assign/view.php?id=7201',
    action: null,
    source: 'calendar',
    evidence: null,
    sourceUrl: null,
    isNew: false,
    submission: null,
    ...patch,
  };
}

const row = (cmid: number, status: string, grade = '') => `<tr data-mdl-overview-cmid="${cmid}">
<td class=" text-start" data-mdl-overview-item="name" data-mdl-overview-value="課題 ${cmid}"><a href="#">課題</a></td>
<td class=" text-start" data-mdl-overview-item="duedate" data-mdl-overview-value="1791471540">x</td>
<td class=" text-start" data-mdl-overview-item="submissionstatus" data-mdl-overview-value="${status}"> ${status} </td>
<td class=" text-end" data-mdl-overview-item="評点" data-mdl-overview-value="${grade}"> ${grade || '-'} </td>
</tr>`;
const overview = (rows: string[]) =>
  `<div id="region-main"><table class="course-overview-table"><tbody>${rows.join('\n')}</tbody></table></div>`;

// one overview page per course answers its assignments and quizzes
const OVERVIEW_A = '/course/overview.php?id=99101&expand[]=assign&expand[]=quiz';
const OVERVIEW_B = '/course/overview.php?id=99102&expand[]=assign&expand[]=quiz';

function setup(opts: WebApiOptions) {
  const api = makeWebApi(opts);
  const { ctx } = makeFakeContext({});
  return { api, ctx: { ...ctx, moodle: async () => api } };
}

const byCmid = (items: DueItem[]) => Object.fromEntries(items.map((i) => [i.cmid, i.submission]));

describe('attachSubmissions on the web channel', () => {
  it('reads assignments from one overview page per course, quizzes and questionnaires from their pages', async () => {
    const { api, ctx } = setup({
      pages: {
        [OVERVIEW_A]: overview([
          row(7201, '評定のために提出済み', '85.00000'),
          row(7202, '提出なし', '-'),
          row(7203, 'Draft (not submitted)'),
        ]),
        [OVERVIEW_B]: overview([row(7204, 'Mystery status')]),
        '/mod/questionnaire/view.php?id=7401': fixture('questionnaire-view-ja.html'),
      },
      handlers: {
        mod_quiz_get_user_quiz_attempts: { attempts: [{ attempt: 1, state: 'inprogress', timefinish: 0 }] },
        mod_quiz_get_attempt_access_information: { preventnewattemptreasons: [] },
      },
    });
    const items = [
      item({ cmid: 7201 }),
      item({ cmid: 7202 }),
      item({ cmid: 7203 }),
      item({ cmid: 7204, courseId: 99102 }),
      item({ kind: 'quiz', cmid: 7301 }),
      item({ kind: 'questionnaire', cmid: 7401 }),
    ];
    const out = byCmid(await attachSubmissions(ctx, items));
    expect(out[7201]).toEqual({ status: 'submitted', canContinue: false, submittedAt: null, graded: true, note: null });
    expect(out[7202]).toMatchObject({ status: 'none', graded: false });
    expect(out[7203]).toMatchObject({ status: 'draft' });
    expect(out[7204]).toBeNull();
    expect(out[7301]).toMatchObject({ status: 'in-progress', canContinue: true });
    expect(out[7401]).toMatchObject({ status: 'submitted', canContinue: true });
    expect([...api.pageCalls].sort()).toEqual(
      [`GET ${OVERVIEW_A}`, `GET ${OVERVIEW_B}`, 'GET /mod/questionnaire/view.php?id=7401'].sort(),
    );
    // no instance lookups and no mobile batch on this channel; the quiz reads name its cmid
    expect(api.calls.map((c) => c.fn).sort()).toEqual([
      'mod_quiz_get_attempt_access_information',
      'mod_quiz_get_user_quiz_attempts',
    ]);
    expect(api.calls.every((c) => c.hint?.cmid === 7301 && c.params.quizid === 7301)).toBe(true);
  });

  it('checks only what the call budget leaves (6 kept), nearest deadlines first; the rest stays unknown', async () => {
    const view = fixture('questionnaire-view-ja.html');
    const pages = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`/mod/questionnaire/view.php?id=${7401 + i}`, view]),
    );
    const { api, ctx } = setup({ pages, spent: 30 });
    const items = Array.from({ length: 6 }, (_, i) =>
      item({ kind: 'questionnaire', cmid: 7401 + i, dueAt: `2026-10-${20 - i}T23:59:00+09:00` }),
    );
    const out = byCmid(await attachSubmissions(ctx, items));
    // 40 - 30 spent - 6 kept = 4 pages: the four nearest deadlines (10-15 … 10-18)
    expect(api.pageCalls).toHaveLength(4);
    const checked = Object.entries(out).filter(([, s]) => s !== null);
    expect(checked.map(([cmid]) => Number(cmid)).sort()).toEqual([7403, 7404, 7405, 7406]);
    expect(out[7401]).toBeNull();
    expect(out[7402]).toBeNull();
  });

  it('opens at most 6 quiz pages (nearest first); a later quiz joins an overview page read anyway', async () => {
    const quizRow = (cmid: number, grade: string) => `<tr data-mdl-overview-cmid="${cmid}">
<td data-mdl-overview-item="name" data-mdl-overview-value="小テスト ${cmid}">x</td>
<td data-mdl-overview-item="評点" data-mdl-overview-value="${grade}"> ${grade || '-'} </td></tr>`;
    const { api, ctx } = setup({
      pages: { [OVERVIEW_A]: overview([row(7201, '提出なし'), quizRow(7309, '8.00000'), quizRow(7310, '-')]) },
      handlers: {
        mod_quiz_get_user_quiz_attempts: { attempts: [] },
        mod_quiz_get_attempt_access_information: { preventnewattemptreasons: [] },
      },
    });
    // quizzes 7301…7310 due 10-11 … 10-20; course 99102 has no overview page planned (no assignment there)
    const quizzes = Array.from({ length: 10 }, (_, i) =>
      item({
        kind: 'quiz',
        cmid: 7301 + i,
        courseId: i === 7 ? 99102 : 99101,
        dueAt: `2026-10-${String(11 + i).padStart(2, '0')}T23:59:00+09:00`,
      }),
    );
    const items = [...quizzes, item({ cmid: 7201, dueAt: '2026-10-25T23:59:00+09:00' })];
    const out = byCmid(await attachSubmissions(ctx, items));
    const quizPages = new Set(api.calls.map((c) => c.hint?.cmid));
    expect([...quizPages].sort()).toEqual([7301, 7302, 7303, 7304, 7305, 7306]);
    expect(api.pageCalls).toEqual([`GET ${OVERVIEW_A}`]); // the fake answers the quiz reads through `calls`
    for (const cmid of [7301, 7306]) expect(out[cmid]).toMatchObject({ status: 'none' });
    expect(out[7309]).toEqual({ status: 'submitted', canContinue: false, submittedAt: null, graded: true, note: null });
    expect(out[7310]).toBeNull(); // no grade: an attempt may still exist
    expect(out[7307]).toBeNull(); // not on the page
    expect(out[7308]).toBeNull(); // its course's overview is not read for it alone
    expect(out[7201]).toMatchObject({ status: 'none' });
  });

  it('leaves the statuses unknown when an overview page fails', async () => {
    const { ctx } = setup({ pages: {} });
    const out = byCmid(await attachSubmissions(ctx, [item({ cmid: 7201 })]));
    expect(out[7201]).toBeNull();
  });
});

describe('attachSubmissions light plan (the console course overview)', () => {
  const lightOverview = (courseId: number) =>
    `/course/overview.php?id=${courseId}&expand[]=assign&expand[]=questionnaire&expand[]=quiz`;
  const responded = (cmid: number, value: string) => `<tr data-mdl-overview-cmid="${cmid}">
<td class=" text-start" data-mdl-overview-item="name" data-mdl-overview-value="アンケート ${cmid}">x</td>
<td class=" text-center" data-mdl-overview-item="responded" data-mdl-overview-value="${value}"> </td></tr>`;
  const graded = (cmid: number, grade: string) => `<tr data-mdl-overview-cmid="${cmid}">
<td data-mdl-overview-item="name" data-mdl-overview-value="小テスト ${cmid}">x</td>
<td data-mdl-overview-item="評点" data-mdl-overview-value="${grade}"> ${grade || '-'} </td></tr>`;
  const day = (d: number, time: string) => `2026-10-${String(d).padStart(2, '0')}T${time}:00+09:00`;

  /** Course 9910<n>: a quiz (21:00), a questionnaire (22:00) and an assignment (23:59) due on 10-1<n>. */
  function course(n: number): DueItem[] {
    const courseId = 99100 + n;
    return [
      item({ kind: 'quiz', cmid: 7300 + n, courseId, dueAt: day(10 + n, '21:00') }),
      item({ kind: 'questionnaire', cmid: 7400 + n, courseId, dueAt: day(10 + n, '22:00') }),
      item({ cmid: 7200 + n, courseId, dueAt: day(10 + n, '23:59') }),
    ];
  }

  it('reads at most 6 pages, nearest first: course overview pages answer assignments and questionnaires', async () => {
    const pages = {
      [lightOverview(99101)]: overview([row(7201, '提出なし'), responded(7401, '1')]),
      [lightOverview(99102)]: overview([row(7202, '評定のために提出済み'), responded(7402, '0')]),
      [lightOverview(99103)]: overview([row(7203, 'Draft (not submitted)'), responded(7403, '1'), graded(7303, '8')]),
      [lightOverview(99104)]: overview([row(7204, '提出なし'), responded(7404, ''), graded(7304, '')]),
    };
    const { api, ctx } = setup({
      pages,
      handlers: {
        mod_quiz_get_user_quiz_attempts: { attempts: [{ attempt: 1, state: 'inprogress', timefinish: 0 }] },
        mod_quiz_get_attempt_access_information: { preventnewattemptreasons: [] },
      },
    });
    const items = [1, 2, 3, 4, 5, 6, 7, 8].flatMap(course);
    const out = byCmid(await attachSubmissions(ctx, items, { maxSubmissionChecks: 150, webStatus: 'light' }));

    // 2 quiz pages + 4 course overview pages; no questionnaire page
    const quizPages = new Set(api.calls.map((c) => c.hint?.cmid));
    expect([...quizPages].sort()).toEqual([7301, 7302]);
    expect([...api.pageCalls].sort()).toEqual([1, 2, 3, 4].map((n) => `GET ${lightOverview(99100 + n)}`).sort());
    expect(out[7301]).toMatchObject({ status: 'in-progress' });
    expect(out[7201]).toMatchObject({ status: 'none' });
    const answered = { status: 'submitted', canContinue: false, submittedAt: null, graded: false, note: null };
    expect(out[7401]).toEqual(answered);
    expect(out[7202]).toMatchObject({ status: 'submitted' });
    expect(out[7402]).toMatchObject({ status: 'none', canContinue: true });
    expect(out[7203]).toMatchObject({ status: 'draft' });
    expect(out[7303]).toMatchObject({ status: 'submitted', graded: true }); // joined its course's page
    expect(out[7404]).toBeNull(); // no machine value
    expect(out[7304]).toBeNull(); // no grade: unknown
    for (const cmid of [7305, 7405, 7205, 7208, 7308, 7408]) expect(out[cmid]).toBeNull(); // beyond the 6 pages
  });

  it('the due list (full plan) reads far more pages for the same items', async () => {
    const { api, ctx } = setup({
      handlers: {
        mod_quiz_get_user_quiz_attempts: { attempts: [] },
        mod_quiz_get_attempt_access_information: { preventnewattemptreasons: [] },
      },
    });
    await attachSubmissions(ctx, [1, 2, 3, 4, 5, 6, 7, 8].flatMap(course), { maxSubmissionChecks: 150 });
    const quizPages = new Set(api.calls.map((c) => c.hint?.cmid)).size;
    // 6 quiz pages + 8 questionnaire pages + 8 course overview pages
    expect(quizPages + api.pageCalls.length).toBe(22);
  });
});

describe('callBatch on the web channel', () => {
  it('runs every request through the client with its hint; a failing one fails alone', async () => {
    const api = makeWebApi({
      handlers: {
        ok_fn: (params: Record<string, unknown>) => ({ echoed: params.x }),
        bad_fn: () => {
          throw new MoodleError('nope', 'nopermissions');
        },
      },
    });
    const results = await callBatch(api, [
      { fn: 'ok_fn', args: { x: 1 }, hint: { cmid: 7001 } },
      { fn: 'bad_fn', args: {} },
      { fn: 'ok_fn', args: { x: 2 } },
    ]);
    expect(results).toEqual([{ ok: true, data: { echoed: 1 } }, { ok: false }, { ok: true, data: { echoed: 2 } }]);
    expect(api.calls.map((c) => c.hint)).toEqual([{ cmid: 7001 }, undefined, undefined]);
    expect(api.calls.some((c) => c.fn === 'tool_mobile_call_external_functions')).toBe(false);
  });
});
