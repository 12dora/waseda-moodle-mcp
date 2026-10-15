import { describe, expect, it } from 'vitest';
import { encodeParams } from '../../src/core/moodle/client';
import { parseAssignStatus } from '../../src/core/services/submission/assign';
import { callBatch } from '../../src/core/services/submission/batch';
import {
  parseQuestionnaire,
  parseSubmitTime,
  questionnaireRequest,
} from '../../src/core/services/submission/questionnaire';
import { parseQuizState } from '../../src/core/services/submission/quiz';
import draft from '../fixtures/submission/questionnaire-draft.json';
import answeredEn from '../fixtures/submission/questionnaire-en-answered.json';
import answered from '../fixtures/submission/questionnaire-ja-answered.json';
import answeredEnded from '../fixtures/submission/questionnaire-ja-closed-answered.json';
import open from '../fixtures/submission/questionnaire-open.json';
import savedListed from '../fixtures/submission/questionnaire-saved-listed.json';
import { makeFakeContext } from '../helpers/fake-context';

const BATCH = 'tool_mobile_call_external_functions';
const SUBMITTED_TS = 1791947460; // 2026-10-14 12:11 JST

describe('parseQuestionnaire', () => {
  it('reads an answered questionnaire and the submit time, not the end time of the survey', () => {
    expect(parseQuestionnaire(answeredEnded)).toEqual({
      status: 'submitted',
      canContinue: false,
      submittedAt: '2026-10-08T11:11:00+09:00',
      graded: false,
      note: null,
    });
    expect(parseQuestionnaire(answered)).toMatchObject({
      status: 'submitted',
      submittedAt: '2026-10-11T15:29:00+09:00',
    });
  });

  it('reads the English date format', () => {
    expect(parseQuestionnaire(answeredEn)).toMatchObject({
      status: 'submitted',
      submittedAt: '2026-10-11T15:29:00+09:00',
    });
  });

  it('treats the answer button alone as "not started"', () => {
    expect(parseQuestionnaire(open)).toEqual({
      status: 'none',
      canContinue: true,
      submittedAt: null,
      graded: false,
      note: null,
    });
  });

  it('treats a resume key as a saved draft', () => {
    expect(parseQuestionnaire(draft)).toMatchObject({ status: 'draft', canContinue: true, submittedAt: null });
  });

  it('a saved response listed under "submitted" next to the resume button is still a draft', () => {
    expect(parseQuestionnaire(savedListed)).toEqual({
      status: 'draft',
      canContinue: true,
      submittedAt: null,
      graded: false,
      note: null,
    });
    const earlier = "{{ 'plugin.mod_questionnaire.submitted' | translate }} 2026年 10月 8日(木曜日) 11:11 <b></b>";
    const html = `${earlier} ${earlier} {{ 'plugin.mod_questionnaire.resumesurvey' | translate }}`;
    expect(parseQuestionnaire({ templates: [{ html }] })).toMatchObject({
      status: 'draft',
      note: '1 earlier response(s) submitted',
    });
  });

  it('can still answer when the button is shown next to the review link', () => {
    const html = "{{ 'plugin.mod_questionnaire.submitted' | translate }} 2026年 10月 8日(木曜日) 11:11 <b></b>";
    const again = `${html} {{ 'plugin.mod_questionnaire.answerquestions' | translate }}`;
    expect(parseQuestionnaire({ templates: [{ html: again }] })).toMatchObject({
      status: 'submitted',
      canContinue: true,
    });
  });

  it('answered without a readable time is still submitted', () => {
    const html = "<ion-label>{{ 'plugin.mod_questionnaire.submitted' | translate }} sometime</ion-label>";
    expect(parseQuestionnaire({ templates: [{ html }] })).toMatchObject({ status: 'submitted', submittedAt: null });
  });

  it('returns null for anything it does not recognise', () => {
    const other = "{{ 'plugin.mod_questionnaire.other' | translate }}";
    expect(parseQuestionnaire({ templates: [{ html: '<div>nothing here</div>' }] })).toBeNull();
    expect(parseQuestionnaire({ templates: [{ html: other }] })).toBeNull();
    expect(parseQuestionnaire({ templates: [] })).toBeNull();
    expect(parseQuestionnaire(null)).toBeNull();
    expect(parseQuestionnaire('<html>')).toBeNull();
  });

  it('asks the mobile content web service for the cmid, the Moodle user and course 0', () => {
    expect(questionnaireRequest(5102, 1001)).toEqual({
      fn: 'tool_mobile_get_content',
      args: {
        component: 'mod_questionnaire',
        method: 'mobile_view_activity',
        args: [
          { name: 'cmid', value: '5102' },
          { name: 'userid', value: '1001' },
          { name: 'courseid', value: '0' },
        ],
      },
    });
  });
});

describe('parseSubmitTime', () => {
  it.each([
    ['2026年 10月 8日(木曜日) 11:11', '2026-10-08T11:11:00+09:00'],
    ['2026年10月8日 9:05', '2026-10-08T09:05:00+09:00'],
    ['Thursday, 8 October 2026, 11:11 AM', '2026-10-08T11:11:00+09:00'],
    ['Sunday, 11 October 2026, 3:29 PM', '2026-10-11T15:29:00+09:00'],
    ['Thursday, October 8, 2026, 12:05 AM', '2026-10-08T00:05:00+09:00'],
    ['October 8th, 2026, 12:30 pm', '2026-10-08T12:30:00+09:00'],
    ['8 Oct 2026, 23:30', '2026-10-08T23:30:00+09:00'],
  ])('%s', (text, iso) => {
    expect(parseSubmitTime(text)).toBe(iso);
  });

  it('returns null for text that is not a date and for impossible values', () => {
    expect(parseSubmitTime('')).toBeNull();
    expect(parseSubmitTime('submitted yesterday')).toBeNull();
    expect(parseSubmitTime('2026年 13月 8日 11:11')).toBeNull();
    expect(parseSubmitTime('2026年 10月 8日 25:11')).toBeNull();
  });
});

describe('parseAssignStatus', () => {
  const status = (submission: object | null, last: object = {}) => ({
    lastattempt: {
      submission,
      canedit: true,
      cansubmit: false,
      locked: false,
      gradingstatus: 'notgraded',
      ...last,
    },
  });

  it('new -> none', () => {
    expect(parseAssignStatus(status({ status: 'new', timemodified: 0 }))).toEqual({
      status: 'none',
      canContinue: true,
      submittedAt: null,
      graded: false,
      note: null,
    });
  });

  it('draft -> draft, with a note when the submit button was not pressed', () => {
    expect(parseAssignStatus(status({ status: 'draft', timemodified: SUBMITTED_TS }, { cansubmit: true }))).toEqual({
      status: 'draft',
      canContinue: true,
      submittedAt: null,
      graded: false,
      note: 'submit button not pressed',
    });
    expect(parseAssignStatus(status({ status: 'draft', timemodified: SUBMITTED_TS }))).toMatchObject({ note: null });
    expect(parseAssignStatus(status({ status: 'draft' }, { canedit: false }))).toMatchObject({ canContinue: false });
  });

  it('submitted -> submitted at the modification time; editable unless locked or not editable', () => {
    const sub = { status: 'submitted', timemodified: SUBMITTED_TS };
    expect(parseAssignStatus(status(sub))).toEqual({
      status: 'submitted',
      canContinue: true,
      submittedAt: '2026-10-14T12:11:00+09:00',
      graded: false,
      note: null,
    });
    expect(parseAssignStatus(status(sub, { locked: true }))).toMatchObject({ canContinue: false });
    expect(parseAssignStatus(status(sub, { canedit: false }))).toMatchObject({ canContinue: false });
  });

  it('flags a graded submission', () => {
    const sub = { status: 'submitted', timemodified: SUBMITTED_TS };
    expect(parseAssignStatus(status(sub, { gradingstatus: 'graded' }))).toMatchObject({ graded: true });
  });

  it('reopened -> reopened and still editable', () => {
    expect(parseAssignStatus(status({ status: 'reopened', timemodified: SUBMITTED_TS }))).toEqual({
      status: 'reopened',
      canContinue: true,
      submittedAt: null,
      graded: false,
      note: null,
    });
  });

  it('reads the team submission of a team assignment', () => {
    const data = {
      lastattempt: {
        submission: { status: 'new' },
        teamsubmission: { status: 'submitted', timemodified: SUBMITTED_TS },
        canedit: true,
        locked: false,
      },
    };
    expect(parseAssignStatus(data)).toMatchObject({ status: 'submitted', submittedAt: '2026-10-14T12:11:00+09:00' });
  });

  it('returns null when the status is missing or unknown', () => {
    expect(parseAssignStatus(null)).toBeNull();
    expect(parseAssignStatus({})).toBeNull();
    expect(parseAssignStatus(status(null))).toBeNull();
    expect(parseAssignStatus(status({ status: 'weird' }))).toBeNull();
    expect(parseAssignStatus(status({ status: 'constructor' }))).toBeNull();
  });
});

describe('parseQuizState', () => {
  const attempt = (n: number, state: string, extra: object = {}) => ({
    attempt: n,
    state,
    timefinish: state === 'finished' ? SUBMITTED_TS : 0,
    preview: 0,
    ...extra,
  });
  const mayAttempt = { preventnewattemptreasons: [] };
  const blocked = { preventnewattemptreasons: ['No more attempts are allowed'] };

  it('an open attempt -> in-progress, whatever the access information says', () => {
    const attempts = { attempts: [attempt(1, 'finished'), attempt(2, 'inprogress')] };
    expect(parseQuizState({ attempts, access: blocked, attemptsAllowed: 3 })).toEqual({
      status: 'in-progress',
      canContinue: true,
      submittedAt: null,
      graded: false,
      note: 'attempt 2 of 3',
    });
    expect(parseQuizState({ attempts: { attempts: [attempt(1, 'overdue')] }, access: null })).toMatchObject({
      status: 'in-progress',
      note: 'attempt 1',
    });
  });

  it('a finished attempt -> submitted; canContinue = another attempt is allowed', () => {
    const attempts = { attempts: [attempt(1, 'finished')] };
    expect(parseQuizState({ attempts, access: mayAttempt, attemptsAllowed: 2 })).toEqual({
      status: 'submitted',
      canContinue: true,
      submittedAt: '2026-10-14T12:11:00+09:00',
      graded: false,
      note: 'attempt 1 of 2',
    });
    expect(parseQuizState({ attempts, access: blocked })).toMatchObject({ canContinue: false, note: 'attempt 1' });
  });

  it('uses the latest finish time and the highest attempt number', () => {
    const attempts = {
      attempts: [attempt(2, 'finished', { timefinish: SUBMITTED_TS + 600 }), attempt(1, 'finished')],
    };
    expect(parseQuizState({ attempts, access: mayAttempt })).toMatchObject({
      submittedAt: '2026-10-14T12:21:00+09:00',
      note: 'attempt 2',
    });
  });

  it('no attempt -> none; abandoned attempts and teacher previews do not count', () => {
    expect(parseQuizState({ attempts: { attempts: [] }, access: mayAttempt })).toEqual({
      status: 'none',
      canContinue: true,
      submittedAt: null,
      graded: false,
      note: null,
    });
    const noise = { attempts: [attempt(1, 'abandoned'), attempt(2, 'finished', { preview: 1 })] };
    expect(parseQuizState({ attempts: noise, access: blocked })).toMatchObject({ status: 'none', canContinue: false });
  });

  it('without access information a finished quiz is still submitted, but not continuable', () => {
    const attempts = { attempts: [attempt(1, 'finished')] };
    expect(parseQuizState({ attempts, access: undefined })).toMatchObject({ status: 'submitted', canContinue: false });
  });

  it('returns null when the attempts cannot be read', () => {
    expect(parseQuizState({ attempts: null, access: mayAttempt })).toBeNull();
    expect(parseQuizState({ attempts: { attempts: 'x' }, access: mayAttempt })).toBeNull();
  });
});

describe('callBatch', () => {
  const encode = (data: unknown) => ({ error: false, data: JSON.stringify(data) });

  it('sends one call with function / JSON arguments per request and decodes the responses in order', async () => {
    const failed = { error: true, exception: { errorcode: 'x' } };
    const { api } = makeFakeContext({
      responses: { [BATCH]: () => ({ responses: [encode({ a: 1 }), failed, encode(null)] }) },
    });
    const results = await callBatch(api, [
      { fn: 'fn_one', args: { assignid: 7 } },
      { fn: 'fn_two', args: { quizid: 8, status: 'all' } },
      { fn: 'fn_three', args: {} },
    ]);
    expect(results).toEqual([{ ok: true, data: { a: 1 } }, { ok: false }, { ok: true, data: null }]);
    expect(api.calls).toEqual([
      {
        fn: BATCH,
        params: {
          requests: [
            { function: 'fn_one', arguments: '{"assignid":7}' },
            { function: 'fn_two', arguments: '{"quizid":8,"status":"all"}' },
            { function: 'fn_three', arguments: '{}' },
          ],
        },
      },
    ]);
  });

  it('encodes as PHP arrays: requests[i][function] and requests[i][arguments] (JSON string)', async () => {
    const { api } = makeFakeContext({ responses: { [BATCH]: { responses: [] } } });
    await callBatch(api, [{ fn: 'fn_one', args: { assignid: 7 } }]);
    const params = api.calls[0]?.params ?? {};
    expect([...encodeParams(params)]).toEqual([
      ['requests[0][function]', 'fn_one'],
      ['requests[0][arguments]', '{"assignid":7}'],
    ]);
  });

  it('fails a request whose response is missing, not an object, or carries data that is not JSON', async () => {
    const { api } = makeFakeContext({
      responses: { [BATCH]: { responses: [{ error: false, data: '{oops' }, null, { error: false }] } },
    });
    const results = await callBatch(api, [
      { fn: 'a', args: {} },
      { fn: 'b', args: {} },
      { fn: 'c', args: {} },
      { fn: 'd', args: {} },
    ]);
    expect(results).toEqual([{ ok: false }, { ok: false }, { ok: false }, { ok: false }]);
  });

  it('splits into chunks of 40, one Moodle call per chunk, results in request order', async () => {
    const { api } = makeFakeContext({
      responses: {
        [BATCH]: (params: Record<string, unknown>) => ({
          responses: (params.requests as Array<{ arguments: string }>).map((r) => encode(JSON.parse(r.arguments))),
        }),
      },
    });
    const requests = Array.from({ length: 85 }, (_, i) => ({ fn: 'f', args: { n: i } }));
    const results = await callBatch(api, requests);
    expect(api.count(BATCH)).toBe(3);
    expect(api.calls.map((c) => (c.params.requests as unknown[]).length)).toEqual([40, 40, 5]);
    expect(results).toHaveLength(85);
    expect(results.map((r) => (r.ok ? (r.data as { n: number }).n : -1))).toEqual(requests.map((_, i) => i));
  });

  it('a failing chunk fails only its own requests and never throws', async () => {
    const { api } = makeFakeContext({
      responses: {
        [BATCH]: (params: Record<string, unknown>, index: number) => {
          if (index === 0) throw new Error('boom');
          return { responses: (params.requests as unknown[]).map(() => encode('ok')) };
        },
      },
      memoize: false,
    });
    const requests = Array.from({ length: 41 }, (_, i) => ({ fn: 'f', args: { n: i } }));
    const results = await callBatch(api, requests);
    expect(results.slice(0, 40).every((r) => !r.ok)).toBe(true);
    expect(results[40]).toEqual({ ok: true, data: 'ok' });
  });

  it('makes no call for no requests', async () => {
    const { api } = makeFakeContext({ responses: { [BATCH]: { responses: [] } } });
    expect(await callBatch(api, [])).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });
});
