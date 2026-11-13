import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, NeedsReconnect } from '../../src/core/errors';
import { confirmAction, prepareQuestionnaire } from '../../src/core/services/actions';
import type { QuestionnaireAnswerInput } from '../../src/core/services/actions/questionnaire';
import { listAllCourses } from '../../src/core/services/courses';
import closed from '../fixtures/questionnaire/index-closed.json';
import page1Refused from '../fixtures/questionnaire/page1-refused.json';
import page2Refused from '../fixtures/questionnaire/page2-refused.json';
import respondDraft from '../fixtures/questionnaire/respond-draft.json';
import page1 from '../fixtures/questionnaire/respond-page1.json';
import page2 from '../fixtures/questionnaire/respond-page2.json';
import page2Saved from '../fixtures/questionnaire/respond-page2-rid.json';
import draftIndex from '../fixtures/submission/questionnaire-draft.json';
import answeredIndex from '../fixtures/submission/questionnaire-ja-answered.json';
import openIndex from '../fixtures/submission/questionnaire-open.json';
import { BASE_URL, createTestContext } from '../helpers/fake-context-be4';

vi.mock('../../src/core/services/courses', () => ({ listAllCourses: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T12:00:00+09:00'));
  vi.mocked(listAllCourses).mockResolvedValue([{ id: 99, name: '総合日本語３Ｘ' } as never]);
});
afterEach(() => {
  vi.useRealTimers();
});

type Args = Record<string, string>;
const argsOf = (params: Record<string, unknown>): Args =>
  Object.fromEntries((params.args as Array<{ name: string; value: string }>).map((a) => [a.name, a.value]));

interface Pages {
  index?: unknown;
  respond?: (a: Args) => unknown;
  nextpage?: unknown;
  previouspage?: unknown;
  submit?: unknown;
  /** Answers every mobile-page call instead of the views above. */
  moodle?: (a: Args) => unknown;
}

/** A two-page questionnaire by default: page 1 / page 2, nextpage hands out rid 9010, submit lists a response. */
function setup(pages: Pages = {}) {
  const t = createTestContext();
  const views: Required<Omit<Pages, 'moodle'>> = {
    index: openIndex,
    respond: (a: Args) => (a.pagenum === '1' ? page1 : page2),
    nextpage: page2Saved,
    previouspage: page1,
    submit: answeredIndex,
    ...pages,
  };
  t.moodle.handlers.core_course_get_course_module = {
    cm: { id: 101, course: 99, modname: 'questionnaire', instance: 9101, name: 'x' },
  };
  t.moodle.handlers.core_course_get_contents = [{ modules: [{ id: 101, name: 'Session 3 report', dates: [] }] }];
  t.moodle.handlers.tool_mobile_get_content = (params: Record<string, unknown>) => {
    const a = argsOf(params);
    if (pages.moodle) return pages.moodle(a);
    if (!a.action) return views.index;
    if (a.action === 'respond') return views.respond(a);
    if (a.action === 'previouspage') return views.previouspage;
    return a.action === 'nextpage' ? views.nextpage : views.submit;
  };
  const sent = () => t.moodle.callsTo('tool_mobile_get_content').map(argsOf);
  return { ...t, sent };
}

const FULL: QuestionnaireAnswerInput[] = [
  { questionId: 5001, text: 'Hana' },
  { questionId: 5002, text: 'Positioning matters.' },
  { questionId: 5003, choiceIds: ['7003'], otherText: 'Home' },
  { questionId: 5004, choiceIds: [7101, '7104'], otherText: 'Podcasts' },
  { questionId: 5005, choiceIds: ['1'] },
  {
    questionId: 5007,
    rating: [
      { rowId: 7301, value: 3 },
      { rowId: '7302', value: 'N/A' },
    ],
  },
  { questionId: 5008, text: '12' },
  { questionId: 5009, text: '2026-11-01' },
  { questionId: 5010, text: '7' },
];
const without = (id: number) => FULL.filter((a) => a.questionId !== id);

/** The fields FULL gives each page, as the plugin stores them (one row per field). */
const PAGE1_ROWS = [
  'response_1_5005=1',
  'response_2_5001=Hana',
  'response_3_5002=Positioning matters.',
  'response_4_5003=7003',
  'response_4_5003_o7003=Home',
  'response_5_5004_7101=1',
  'response_5_5004_7104=1',
  'response_5_5004_o7104=Podcasts',
];
const PAGE2_ROWS = [
  'response_10_5008=12',
  'response_11_5010=7',
  'response_8_5007_7301=3',
  'response_8_5007_7302=-1',
  'response_9_5009=2026-11-01',
];

/**
 * The plugin's answer storage as these calls reach it (questionnaire.class.php): `nextpage` / `previouspage` delete
 * the page's rows and insert the sent ones (existing_response_action); `submit` with completed=0 only inserts
 * (response_insert), and submit=1 commits. A save without rid creates a response.
 */
function pluginModel(draft?: { rid: number; pages: Record<number, string[]> }) {
  const rows = new Map<number, Map<number, string[]>>();
  const complete = new Set<number>();
  let created = 0;
  const copy = ([pg, list]: [string, string[]]): [number, string[]] => [Number(pg), [...list]];
  if (draft) rows.set(draft.rid, new Map(Object.entries(draft.pages).map(copy)));
  const open = () => [...rows.keys()].some((rid) => !complete.has(rid));
  function save(a: Args, replace: boolean): number {
    let rid = Number(a.rid);
    if (!rid) {
      created++;
      rid = 9009 + created;
    }
    const pages = rows.get(rid) ?? new Map<number, string[]>();
    rows.set(rid, pages);
    const sent = Object.entries(a)
      .filter(([k]) => k.startsWith('response_'))
      .map(([k, v]) => `${k}=${v}`);
    const page = Number(a.pagenum);
    pages.set(page, [...(replace ? [] : (pages.get(page) ?? [])), ...sent]);
    return rid;
  }
  function index(): unknown {
    if (open()) return draftIndex;
    return complete.size ? answeredIndex : openIndex;
  }
  function submit(a: Args): unknown {
    const rid = save(a, false);
    if (a.submit === '1') complete.add(rid);
    return complete.has(rid) ? answeredIndex : draftIndex;
  }
  /** Each action as mobile_view_activity answers it. */
  const actions: Record<string, (a: Args) => unknown> = {
    respond: (a) => {
      if (a.pagenum === '1') return page1;
      return open() ? page2Saved : page2;
    },
    nextpage: (a) => {
      save(a, true);
      return page2Saved;
    },
    previouspage: (a) => {
      save(a, true);
      return page1;
    },
    submit,
  };
  const moodle = (a: Args): unknown => (a.action ? actions[a.action]?.(a) : index());
  const saved = (rid: number) =>
    Object.fromEntries([...(rows.get(rid) ?? [])].map(([pg, list]) => [pg, [...list].sort()]));
  return { moodle, saved, created: () => created };
}

describe('prepareQuestionnaire', () => {
  it('previews every question with its answer in plain words', async () => {
    const { ctx } = setup();
    const preview = await prepareQuestionnaire(ctx, { cmid: 101, answers: FULL });
    expect(preview.kind).toBe('questionnaire_submit');
    expect(preview.title).toBe("Submit answers to 'Session 3 report'");
    expect(preview.details).toEqual([
      'Questionnaire: Session 3 report (総合日本語３Ｘ)',
      'Q1 Your nickname in class: Hana',
      'Q2 What did you learn from the guest lecture?: Positioning matters.',
      'Q3 Where do you usually study?: Other: Home',
      'Q4 Which materials do you use? Choose all that apply.: Textbook; Other: Podcasts',
      'Q5 Did you attend the previous session?: Yes',
      'Q6 Which campus city do you live in?: (no answer)',
      'Q7 Rate the lecture & the materials.: Clarity of the slides: 3; Pace of the lecture: N/A',
      'Q8 How many hours did you study this week?: 12',
      'Q9 When did you start the assignment?: 2026-11-01',
      'Q10 How confident do you feel?: 7',
    ]);
    expect(preview.warnings).toEqual([]);
  });

  it('checks the answers against the questions read now', async () => {
    const { ctx } = setup();
    const fails = (answers: QuestionnaireAnswerInput[]) => prepareQuestionnaire(ctx, { cmid: 101, answers });
    await expect(fails(without(5002))).rejects.toThrow('Required questions are not answered: Q2 (question_id 5002)');
    await expect(fails([...without(5003), { questionId: 5003, choiceIds: ['7001', '7002'] }])).rejects.toThrow(
      'takes exactly one choice',
    );
    await expect(fails([...without(5003), { questionId: 5003, choiceIds: ['7999'] }])).rejects.toThrow(
      'unknown choice id 7999; valid ids: 7001, 7002, 7003',
    );
    await expect(fails([...without(5003), { questionId: 5003, choiceIds: ['7003'] }])).rejects.toThrow(
      'needs other_text',
    );
    const offScale = {
      questionId: 5007,
      rating: [
        { rowId: 7301, value: 9 },
        { rowId: 7302, value: 1 },
      ],
    };
    await expect(fails([...without(5007), offScale])).rejects.toThrow('"9" is not on the scale');
    await expect(fails([...without(5007), { questionId: 5007, rating: [{ rowId: 7301, value: 2 }] }])).rejects.toThrow(
      'every row must be rated',
    );
    await expect(fails([...without(5008), { questionId: 5008, text: 'twelve' }])).rejects.toThrow('must be a number');
    await expect(fails([...without(5009), { questionId: 5009, text: '1 Nov' }])).rejects.toThrow('YYYY-MM-DD');
    await expect(fails([...without(5010), { questionId: 5010, text: '11' }])).rejects.toThrow('1–10');
    await expect(fails([...FULL, { questionId: 4242, text: 'x' }])).rejects.toThrow('question_id 4242 is not in');
    await expect(fails([...FULL, { questionId: 5001, text: 'again' }])).rejects.toThrow('answered twice');
    await expect(fails([])).rejects.toBeInstanceOf(InvalidInput);
  });

  it('refuses a questionnaire that cannot be answered, with Moodle’s notice', async () => {
    const { ctx } = setup({ index: closed });
    await expect(prepareQuestionnaire(ctx, { cmid: 101, answers: FULL })).rejects.toThrow(
      'This questionnaire cannot be answered now: Closed on Thursday, 15 October 2026, 11:59 PM.',
    );
  });

  it('refuses when a page cannot be read', async () => {
    const { ctx } = setup({
      respond: (a) => {
        if (a.pagenum === '1') return page1;
        throw new MoodleError('No access', 'nopermission');
      },
    });
    await expect(prepareQuestionnaire(ctx, { cmid: 101, answers: FULL })).rejects.toThrow('Not every page');
  });

  it('refuses when a later page comes back as the closed index, with its notice', async () => {
    const { ctx } = setup({ respond: (a) => (a.pagenum === '1' ? page1 : closed) });
    await expect(prepareQuestionnaire(ctx, { cmid: 101, answers: FULL })).rejects.toThrow(
      'This questionnaire cannot be answered now: Closed on Thursday, 15 October 2026, 11:59 PM.',
    );
  });

  it('refuses the other_text "0", which Moodle discards', async () => {
    const { ctx } = setup();
    const zero = { questionId: 5003, choiceIds: ['7003'], otherText: ' 0 ' };
    await expect(prepareQuestionnaire(ctx, { cmid: 101, answers: [...without(5003), zero] })).rejects.toThrow(
      'Q3 (question_id 5003): Moodle discards the other_text "0"',
    );
    const boxes = { questionId: 5004, choiceIds: ['7104'], otherText: '0' };
    await expect(prepareQuestionnaire(ctx, { cmid: 101, answers: [...without(5004), boxes] })).rejects.toThrow(
      'Moodle discards the other_text "0"',
    );
  });

  it('takes an optional rating question whole or not at all', async () => {
    const tpl = page2.templates[0] as { id: string; html: string };
    const html = tpl.html.replace(/<ion-badge slot="end" color="danger">[^<]*<\/ion-badge>/, '');
    const optional = { ...page2, templates: [{ ...tpl, html }] };
    const { ctx } = setup({ respond: (a) => (a.pagenum === '1' ? page1 : optional) });
    const oneRow = { questionId: 5007, rating: [{ rowId: 7301, value: 2 }] };
    await expect(prepareQuestionnaire(ctx, { cmid: 101, answers: [...without(5007), oneRow] })).rejects.toThrow(
      'Q7 (question_id 5007): every row must be rated.',
    );
    const skipped = await prepareQuestionnaire(ctx, { cmid: 101, answers: without(5007) });
    expect(skipped.details).toContain('Q7 Rate the lecture & the materials.: (no answer)');
  });

  it('shows a long answer in full, exactly as it is sent', async () => {
    const { ctx, sent } = setup();
    const long = `${'Positioning matters. '.repeat(250)}End.`;
    const answers = [...without(5002), { questionId: 5002, text: long }];
    const preview = await prepareQuestionnaire(ctx, { cmid: 101, answers });
    expect(long.length).toBeGreaterThan(5000);
    expect(preview.details[2]).toBe(`Q2 What did you learn from the guest lecture?: ${long}`);
    await confirmAction(ctx, preview.actionId, 'mcp');
    expect(sent().find((a) => a.action === 'nextpage')?.response_3_5002).toBe(long);
  });
});

describe('questionnaire_submit execution', () => {
  it('saves page 1 with nextpage, hands the rid to the last page and commits with submit', async () => {
    const { ctx, sent } = setup();
    const preview = await prepareQuestionnaire(ctx, { cmid: 101, answers: FULL });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({
      status: 'executed',
      message: 'Answers submitted.',
      url: `${BASE_URL}/mod/questionnaire/view.php?id=101`,
    });
    const [next, last] = sent().slice(-2);
    expect(next).toEqual({
      cmid: '101',
      rid: '0',
      completeq: '1',
      action: 'nextpage',
      pagenum: '1',
      response_2_5001: 'Hana',
      response_3_5002: 'Positioning matters.',
      response_4_5003: '7003',
      response_4_5003_o7003: 'Home',
      response_5_5004_7101: '1',
      response_5_5004_7104: '1',
      response_5_5004_o7104: 'Podcasts',
      response_1_5005: '1',
    });
    expect(last).toEqual({
      cmid: '101',
      questionnaireid: '9101',
      surveyid: '9102',
      userid: '1001',
      pagenum: '2',
      completed: '0',
      rid: '9010',
      submit: '1',
      action: 'submit',
      response_8_5007_7301: '3',
      response_8_5007_7302: '-1',
      response_10_5008: '12',
      response_9_5009: '2026-11-01',
      response_11_5010: '7',
    });
  });

  it('saves a draft without committing and continues the saved response', async () => {
    const { ctx, sent } = setup({
      index: draftIndex,
      respond: () => respondDraft,
      previouspage: respondDraft,
      submit: draftIndex,
    });
    const answers = [
      { questionId: 5001, text: 'Hana' },
      { questionId: 5003, choiceIds: ['7001'] },
    ];
    const preview = await prepareQuestionnaire(ctx, { cmid: 101, answers, final: false });
    expect(preview.title).toBe("Save draft answers to 'Session 3 report'");
    expect(preview.warnings).toEqual([
      'Replaces the answers of the saved draft.',
      'Saved as a draft: it is not submitted until the user submits it in Moodle.',
    ]);
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: 'Answers saved as a draft; submit them in Moodle.' });
    const writes = sent().filter((a) => a.action && a.action !== 'respond');
    // the draft's page is cleared first: `submit` adds to the answers saved on it
    expect(writes).toEqual([
      { cmid: '101', rid: '9003', completeq: '1', action: 'previouspage', pagenum: '1' },
      expect.objectContaining({ action: 'submit', submit: '0', rid: '9003', pagenum: '1', response_4_5003: '7001' }),
    ]);
  });

  it('replaces every page of a continued draft, also when retried after a reconnect', async () => {
    const model = pluginModel({
      rid: 9010,
      pages: {
        1: ['response_2_5001=Old name', 'response_6_5006=7202'],
        2: ['response_10_5008=30', 'response_8_5007_7301=1', 'response_8_5007_7302=2'],
      },
    });
    let rejectSubmit = true;
    const { ctx, store } = setup({
      moodle: (a) => {
        if (a.action === 'submit' && rejectSubmit) throw new NeedsReconnect();
        return model.moodle(a);
      },
    });
    // Q6 and the optional Q8 are left out: the preview shows them unanswered, so the old answers must go
    const preview = await prepareQuestionnaire(ctx, { cmid: 101, answers: without(5008) });
    expect(preview.warnings).toContain('Replaces the answers of the saved draft.');
    await expect(confirmAction(ctx, preview.actionId, 'mcp')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(store.actions.get(preview.actionId)?.status).toBe('pending');
    rejectSubmit = false;
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: 'Answers submitted.' });
    expect(model.saved(9010)).toEqual({ 1: PAGE1_ROWS, 2: PAGE2_ROWS.filter((r) => !r.includes('_5008=')) });
    expect(model.created()).toBe(0);
  });

  it('ends the action when the token fails after it created a response; a new prepare continues it', async () => {
    const model = pluginModel();
    let rejectSubmit = true;
    const { ctx, sent } = setup({
      moodle: (a) => {
        if (a.action === 'submit' && rejectSubmit) throw new NeedsReconnect();
        return model.moodle(a);
      },
    });
    const first = await prepareQuestionnaire(ctx, { cmid: 101, answers: FULL });
    const failed = await confirmAction(ctx, first.actionId, 'mcp');
    expect(failed.status).toBe('failed');
    expect(failed.message).toContain(
      'Page 1 is saved as a draft in Moodle; after reconnecting, prepare the answers again to continue it.',
    );
    rejectSubmit = false;
    const calls = sent().length;
    expect(await confirmAction(ctx, first.actionId, 'mcp')).toMatchObject({ status: 'failed' });
    expect(sent()).toHaveLength(calls);

    const second = await prepareQuestionnaire(ctx, { cmid: 101, answers: FULL });
    expect(second.warnings).toContain('Replaces the answers of the saved draft.');
    const result = await confirmAction(ctx, second.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: 'Answers submitted.' });
    expect(
      sent()
        .filter((a) => a.action === 'nextpage')
        .map((a) => a.rid),
    ).toEqual(['0', '9010']);
    expect(model.created()).toBe(1);
    expect(model.saved(9010)).toEqual({ 1: PAGE1_ROWS, 2: PAGE2_ROWS });
  });

  it('names the page Moodle refused', async () => {
    const first = setup({ nextpage: page1Refused });
    const p1 = await prepareQuestionnaire(first.ctx, { cmid: 101, answers: FULL });
    const r1 = await confirmAction(first.ctx, p1.actionId, 'mcp');
    expect(r1).toMatchObject({ status: 'failed' });
    expect(r1.message).toBe('Moodle did not accept page 1: Please answer the required question #3.');

    const last = setup({ submit: page2Refused });
    const p2 = await prepareQuestionnaire(last.ctx, { cmid: 101, answers: FULL });
    const r2 = await confirmAction(last.ctx, p2.actionId, 'mcp');
    expect(r2.message).toBe(
      'Moodle did not accept page 2: Please answer the required question #7. The earlier pages are saved as a draft in Moodle.',
    );

    const closing = setup({ nextpage: closed });
    const p3 = await prepareQuestionnaire(closing.ctx, { cmid: 101, answers: FULL });
    const r3 = await confirmAction(closing.ctx, p3.actionId, 'mcp');
    expect(r3.message).toBe('Moodle did not accept page 1: Closed on Thursday, 15 October 2026, 11:59 PM.');
  });

  it('fails when Moodle does not confirm the submission', async () => {
    const { ctx } = setup({ submit: closed });
    const preview = await prepareQuestionnaire(ctx, { cmid: 101, answers: FULL });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.message).toContain('Moodle did not confirm the answers (Closed on Thursday');
  });
});
