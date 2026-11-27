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

const OVERVIEW_A = '/course/overview.php?id=99101&expand[]=assign';
const OVERVIEW_B = '/course/overview.php?id=99102&expand[]=assign';

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
          row(7202, '提出なし'),
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

  it('leaves the statuses unknown when an overview page fails', async () => {
    const { ctx } = setup({ pages: {} });
    const out = byCmid(await attachSubmissions(ctx, [item({ cmid: 7201 })]));
    expect(out[7201]).toBeNull();
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
