import { describe, expect, it, vi } from 'vitest';
import { MoodleError } from '../../src/core/errors';
import { attachSubmissions } from '../../src/core/services/submission';
import type { DueItem } from '../../src/core/types';
import draft from '../fixtures/submission/questionnaire-draft.json';
import answered from '../fixtures/submission/questionnaire-ja-answered.json';
import open from '../fixtures/submission/questionnaire-open.json';
import { makeFakeContext } from '../helpers/fake-context';

const BATCH = 'tool_mobile_call_external_functions';
const FINISHED_AT = 1791947460; // 2026-10-14 12:11 JST

function item(patch: Partial<DueItem>): DueItem {
  return {
    kind: 'assign',
    courseId: 101,
    courseName: 'Strategic Marketing',
    cmid: 5001,
    name: 'Report 3',
    opensAt: null,
    dueAt: '2026-10-12T23:59:00+09:00',
    midnightDue: false,
    overdue: true,
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

type Handler = (args: Record<string, unknown>) => unknown;

/** Answers tool_mobile_call_external_functions the way Moodle does: per request `{ error, data: <JSON string> }`. */
function batchResponder(handlers: Record<string, Handler>) {
  return (params: Record<string, unknown>) => ({
    responses: (params.requests as Array<{ function: string; arguments: string }>).map((r) => {
      const handler = handlers[r.function];
      const value = handler?.(JSON.parse(r.arguments) as Record<string, unknown>);
      if (value === undefined || value instanceof Error) return { error: true, exception: '{}' };
      return { error: false, data: JSON.stringify(value) };
    }),
  });
}

const sentFunctions = (params: Record<string, unknown> | undefined) =>
  ((params?.requests ?? []) as Array<{ function: string }>).map((r) => r.function);

/** cmid -> { modname, instance }: instance = cmid + 1000. */
const MODULES: Record<number, string> = { 5001: 'assign', 5002: 'assign', 5003: 'quiz', 5004: 'quiz', 5005: 'forum' };
const moduleOf: Handler = (args) => {
  const cmid = Number(args.cmid);
  const modname = MODULES[cmid];
  if (!modname) return new Error('no such module');
  return { cm: { id: cmid, course: 101, modname, instance: cmid + 1000 } };
};

const assignStatus = (status: string, extra: object = {}) => ({
  lastattempt: {
    submission: { status, timemodified: FINISHED_AT },
    canedit: true,
    cansubmit: status === 'draft',
    locked: false,
    gradingstatus: 'notgraded',
    ...extra,
  },
});

/** The questionnaire fixture by cmid (the mobile content request carries it in args[0]). */
function questionnaireContent(byCmid: Record<number, unknown>): Handler {
  return (args) => {
    const first = (args.args as Array<{ name: string; value: string }>)[0];
    return byCmid[Number(first?.value)];
  };
}

const HANDLERS: Record<string, Handler> = {
  core_course_get_course_module: moduleOf,
  mod_assign_get_submission_status: (a) => {
    if (a.assignid === 6001) return assignStatus('draft');
    if (a.assignid === 6002) return assignStatus('submitted');
    return undefined;
  },
  mod_quiz_get_user_quiz_attempts: (a) => {
    const attempt = (state: string) => ({ attempt: 1, state, timefinish: state === 'finished' ? FINISHED_AT : 0 });
    return { attempts: a.quizid === 6003 ? [attempt('inprogress')] : [attempt('finished')] };
  },
  mod_quiz_get_attempt_access_information: () => ({ preventnewattemptreasons: [] }),
  tool_mobile_get_content: questionnaireContent({ 5102: answered, 5103: open, 5104: draft }),
};

function setup(handlers: Record<string, Handler> = HANDLERS) {
  return makeFakeContext({ responses: { [BATCH]: batchResponder(handlers) }, memoize: false });
}

describe('attachSubmissions', () => {
  it('a submitted questionnaire is no longer overdue; an unanswered one stays overdue', async () => {
    const { ctx } = setup();
    const [done, todo] = await attachSubmissions(ctx, [
      item({ kind: 'questionnaire', cmid: 5102, name: 'Session report', overdue: true }),
      item({ kind: 'questionnaire', cmid: 5103, name: 'Survey', overdue: true }),
    ]);
    expect(done).toMatchObject({
      overdue: false,
      submission: { status: 'submitted', submittedAt: '2026-10-11T15:29:00+09:00' },
    });
    expect(todo).toMatchObject({ overdue: true, submission: { status: 'none', canContinue: true } });
  });

  it('a draft assignment stays overdue and is marked draft; a submitted one is not overdue', async () => {
    const { ctx } = setup();
    const [drafted, submitted] = await attachSubmissions(ctx, [
      item({ cmid: 5001, name: 'Draft report' }),
      item({ cmid: 5002, name: 'Handed in' }),
    ]);
    expect(drafted).toMatchObject({
      overdue: true,
      submission: { status: 'draft', canContinue: true, note: 'submit button not pressed' },
    });
    expect(submitted).toMatchObject({
      overdue: false,
      submission: { status: 'submitted', submittedAt: '2026-10-14T12:11:00+09:00' },
    });
  });

  it('reads quiz attempts: in progress stays outstanding, finished is submitted', async () => {
    const { ctx } = setup();
    const [running, finished] = await attachSubmissions(ctx, [
      item({ kind: 'quiz', cmid: 5003, name: 'Quiz A' }),
      item({ kind: 'quiz', cmid: 5004, name: 'Quiz B' }),
    ]);
    expect(running).toMatchObject({ overdue: true, submission: { status: 'in-progress', canContinue: true } });
    expect(finished).toMatchObject({ overdue: false, submission: { status: 'submitted', canContinue: true } });
  });

  it('leaves a saved questionnaire draft overdue', async () => {
    const { ctx } = setup();
    const [saved] = await attachSubmissions(ctx, [item({ kind: 'questionnaire', cmid: 5104 })]);
    expect(saved).toMatchObject({ overdue: true, submission: { status: 'draft' } });
  });

  it('uses two batched Moodle calls: modules first (no questionnaires), then every status', async () => {
    const { ctx, api } = setup();
    await attachSubmissions(ctx, [
      item({ cmid: 5001 }),
      item({ kind: 'quiz', cmid: 5003 }),
      item({ kind: 'questionnaire', cmid: 5102 }),
    ]);
    expect(api.count(BATCH)).toBe(2);
    expect(sentFunctions(api.calls[0]?.params)).toEqual(Array(2).fill('core_course_get_course_module'));
    expect(api.calls[0]?.params).toEqual({
      requests: [
        { function: 'core_course_get_course_module', arguments: '{"cmid":5001}' },
        { function: 'core_course_get_course_module', arguments: '{"cmid":5003}' },
      ],
    });
    expect(sentFunctions(api.calls[1]?.params)).toEqual([
      'mod_assign_get_submission_status',
      'mod_quiz_get_user_quiz_attempts',
      'mod_quiz_get_attempt_access_information',
      'tool_mobile_get_content',
    ]);
    const requests = (api.calls[1]?.params.requests ?? []) as Array<{ function: string; arguments: string }>;
    expect(JSON.parse(requests[0]?.arguments ?? '{}')).toEqual({ assignid: 6001 }); // the instance, not the cmid
    expect(JSON.parse(requests[3]?.arguments ?? '{}')).toMatchObject({
      component: 'mod_questionnaire',
      args: [
        { name: 'cmid', value: '5102' },
        { name: 'userid', value: '1001' },
        { name: 'courseid', value: '0' },
      ],
    });
  });

  it('checks only assignments, quizzes and questionnaires with a cmid that are not closed', async () => {
    const { ctx, api } = setup();
    const items = [
      item({ kind: 'forum', cmid: 5005 }),
      item({ kind: 'other', cmid: 5006 }),
      item({ kind: 'assign', cmid: null, source: 'text' }),
      item({ kind: 'assign', cmid: 5001, closed: true }),
    ];
    expect(await attachSubmissions(ctx, items)).toEqual(items);
    expect(api.calls).toHaveLength(0);
  });

  it('keeps the other items when only some can be checked', async () => {
    const { ctx } = setup();
    const forum = item({ kind: 'forum', cmid: 5005, name: 'Forum' });
    const result = await attachSubmissions(ctx, [forum, item({ cmid: 5002 })]);
    expect(result[0]).toBe(forum);
    expect(result[1]?.submission?.status).toBe('submitted');
  });

  it('a failing look-up (or an unreadable item) leaves submission null and overdue unchanged', async () => {
    const part = setup({ ...HANDLERS, mod_assign_get_submission_status: () => new Error('denied') });
    const [broken, fine] = await attachSubmissions(part.ctx, [
      item({ cmid: 5001 }),
      item({ kind: 'questionnaire', cmid: 5102 }),
    ]);
    expect(broken).toMatchObject({ overdue: true, submission: null });
    expect(fine).toMatchObject({ overdue: false, submission: { status: 'submitted' } });

    // a module that is not of the expected type, and one Moodle does not know
    const odd = await attachSubmissions(setup().ctx, [item({ kind: 'quiz', cmid: 5001 }), item({ cmid: 4999 })]);
    expect(odd.map((i) => [i.overdue, i.submission])).toEqual([
      [true, null],
      [true, null],
    ]);
  });

  it('never throws: a Moodle error or an unavailable client returns the items untouched', async () => {
    const down = makeFakeContext({ responses: { [BATCH]: new MoodleError('Service unavailable', 'unavailable') } });
    const items = [item({ cmid: 5001 }), item({ kind: 'questionnaire', cmid: 5102 })];
    const result = await attachSubmissions(down.ctx, items);
    expect(result.map((i) => [i.overdue, i.submission])).toEqual([
      [true, null],
      [true, null],
    ]);

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const noClient = { ...down.ctx, moodle: () => Promise.reject(new Error('secret detail')) };
    const same = await attachSubmissions(noClient, items);
    expect(same.map((i) => i.submission)).toEqual([null, null]);
    expect(logged.mock.calls.flat().join(' ')).not.toContain('secret detail'); // only the error name is logged
    logged.mockRestore();
  });

  it('asks Moodle once per cmid and request, even when two listings share the context', async () => {
    const { ctx, api } = setup();
    const items = [item({ cmid: 5001 }), item({ kind: 'questionnaire', cmid: 5102 })];
    const first = await attachSubmissions(ctx, items);
    const again = await attachSubmissions(ctx, [...items, item({ cmid: 5002 })]);
    expect(api.count(BATCH)).toBe(4); // 2 rounds, then 2 rounds for the one new cmid only
    expect(again.slice(0, 2)).toEqual(first);
    expect(again[2]?.submission?.status).toBe('submitted');

    const repeat = await attachSubmissions(ctx, items);
    expect(api.count(BATCH)).toBe(4);
    expect(repeat).toEqual(first);
  });

  it('counts a cmid once and checks at most 40 items per listing', async () => {
    const forty = setup({ tool_mobile_get_content: questionnaireContent({}) });
    const items = Array.from({ length: 45 }, (_, i) => item({ kind: 'questionnaire', cmid: 7000 + i }));
    const result = await attachSubmissions(forty.ctx, [...items, items[0] as DueItem]);
    const requests = (forty.api.calls[0]?.params.requests ?? []) as unknown[];
    expect(forty.api.count(BATCH)).toBe(1); // questionnaires skip round 1
    expect(requests).toHaveLength(40);
    expect(result.slice(0, 40).every((i) => i.submission === null)).toBe(true);
    expect(result.slice(40, 45)).toEqual(items.slice(40));
  });
});
