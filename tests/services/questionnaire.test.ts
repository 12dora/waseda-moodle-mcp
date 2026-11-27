import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MoodleError } from '../../src/core/errors';
import { getActivity } from '../../src/core/services/activity';
import {
  parseQuestionnaireIndex,
  parseQuestionnairePage,
  questionnaireRequest,
} from '../../src/core/services/submission/questionnaire';
import type { QuestionnaireDetail } from '../../src/core/types';
import closed from '../fixtures/questionnaire/index-closed.json';
import notOpen from '../fixtures/questionnaire/index-not-open.json';
import respondDraft from '../fixtures/questionnaire/respond-draft.json';
import page1 from '../fixtures/questionnaire/respond-page1.json';
import page2 from '../fixtures/questionnaire/respond-page2.json';
import review from '../fixtures/questionnaire/review.json';
import draftIndex from '../fixtures/submission/questionnaire-draft.json';
import closedAnswered from '../fixtures/submission/questionnaire-ja-closed-answered.json';
import openIndex from '../fixtures/submission/questionnaire-open.json';
import savedListed from '../fixtures/submission/questionnaire-saved-listed.json';
import { type FakeCall, makeFakeContext } from '../helpers/fake-context-be3';

vi.mock('../../src/core/services/courses', () => ({
  listAllCourses: vi.fn(async () => [{ id: 99, name: '総合日本語３Ｘ' }]),
}));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T12:00:00+09:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

const ts = (iso: string) => Date.parse(iso) / 1000;
const html = (body: string) => ({ templates: [{ id: 'main', html: body }], otherdata: [] });

describe('questionnaireRequest', () => {
  it('adds the read-only view arguments after the index ones', () => {
    const args = (v: Parameters<typeof questionnaireRequest>[2]) =>
      (questionnaireRequest(101, 1001, v).args.args as Array<{ name: string; value: string }>).slice(3);
    expect(args({ action: 'respond', pagenum: 2 })).toEqual([
      { name: 'action', value: 'respond' },
      { name: 'pagenum', value: '2' },
    ]);
    expect(args({ action: 'respond', pagenum: 1, rid: 9003 })).toContainEqual({ name: 'rid', value: '9003' });
    expect(args({ action: 'review', submissionid: 9001 })).toEqual([
      { name: 'action', value: 'review' },
      { name: 'submissionid', value: '9001' },
    ]);
    expect(args(undefined)).toEqual([]);
  });
});

describe('parseQuestionnaireIndex', () => {
  it('reads the buttons, the review links and the draft', () => {
    expect(parseQuestionnaireIndex(openIndex)).toMatchObject({
      canAnswer: true,
      draft: false,
      submissionIds: [],
      notice: null,
    });
    expect(parseQuestionnaireIndex(draftIndex)).toMatchObject({ canAnswer: true, draft: true, draftRid: 9003 });
    expect(parseQuestionnaireIndex(savedListed)).toMatchObject({
      draft: true,
      draftRid: null,
      submissionIds: [9001],
      responses: 0,
    });
  });

  it("keeps Moodle's notice when the questionnaire is closed or not open yet", () => {
    const ended = parseQuestionnaireIndex(closedAnswered);
    expect(ended.canAnswer).toBe(false);
    expect(ended.submissionIds).toHaveLength(1);
    expect(ended.notice).toContain('終了しました');
    expect(parseQuestionnaireIndex(closed)).toMatchObject({
      state: null,
      canAnswer: false,
      notice: 'Closed on Thursday, 15 October 2026, 11:59 PM.',
    });
    expect(parseQuestionnaireIndex(notOpen).notice).toBe(
      'このアンケートは 2026年 11月 19日(木曜日) 08:50 まで開始されません。',
    );
  });

  it('reads nothing from unknown input', () => {
    expect(parseQuestionnaireIndex(null)).toEqual({
      state: null,
      canAnswer: false,
      draft: false,
      draftRid: null,
      submissionIds: [],
      responses: 0,
      exact: true,
      reviewPath: null,
      notice: null,
    });
  });
});

describe('parseQuestionnairePage', () => {
  it('reads every widget of a page with its field ids', () => {
    const { questions, hasNextPage } = parseQuestionnairePage(page1, 1);
    expect(hasNextPage).toBe(true);
    expect(questions.map((q) => [q.id, q.number, q.type, q.required])).toEqual([
      [5001, '1', 'text', true],
      [5002, '2', 'essay', true],
      [5003, '3', 'radio', true],
      [5004, '4', 'checkbox', false],
      [5005, '5', 'yesno', false],
      [5006, '6', 'dropdown', false],
    ]);
    expect(questions[0]).toMatchObject({ page: 1, prompt: 'Your nickname in class', choices: [], answer: null });
    expect(questions[2]?.choices).toEqual([
      { id: '7001', label: 'Library', otherText: false },
      { id: '7002', label: 'Cafeteria', otherText: false },
      { id: '7003', label: 'Other:', otherText: true },
    ]);
    expect(questions[3]?.choices.map((c) => c.id)).toEqual(['7101', '7102', '7103', '7104']);
    expect(questions[3]?.choices[3]?.otherText).toBe(true);
    expect(questions[4]?.choices).toEqual([
      { id: '0', label: 'No', otherText: false },
      { id: '1', label: 'Yes', otherText: false },
    ]);
    expect(questions[5]?.choices.map((c) => c.label)).toEqual(['Tokyo', 'Osaka', 'Kyoto']);
  });

  it('reads rating rows with their scale, numbers, dates and sliders', () => {
    const { questions, hasNextPage } = parseQuestionnairePage(page2, 2);
    expect(hasNextPage).toBe(false);
    expect(questions.map((q) => [q.id, q.type, q.page])).toEqual([
      [5007, 'rate', 2],
      [5008, 'numeric', 2],
      [5009, 'date', 2],
      [5010, 'slider', 2],
    ]);
    const rate = questions[0];
    expect(rate?.prompt).toBe('Rate the lecture & the materials.');
    expect(rate?.choices.map((c) => [c.id, c.label])).toEqual([
      ['7301', 'Clarity of the slides'],
      ['7302', 'Pace of the lecture'],
    ]);
    expect(rate?.scale).toEqual([
      { value: '1', label: '1' },
      { value: '2', label: '2' },
      { value: '3', label: '3' },
      { value: '4', label: '4' },
      { value: '-1', label: 'N/A' },
    ]);
    expect(questions[3]?.range).toEqual({ min: 1, max: 10, step: 1 });
  });

  it('puts the submitted answers in plain words on the review page', () => {
    const answers = Object.fromEntries(parseQuestionnairePage(review, 1).questions.map((q) => [q.id, q.answer]));
    expect(answers).toEqual({
      5001: 'Hana',
      5002: 'Markets reward clear positioning.',
      5003: 'Other: Home',
      5004: 'Textbook; Other: Podcasts',
      5005: 'No',
      5006: 'Osaka',
      5007: 'Clarity of the slides: 3; Pace of the lecture: N/A',
    });
  });

  it('shows the saved draft answers on a respond page', () => {
    const { questions } = parseQuestionnairePage(respondDraft, 1);
    expect(questions.map((q) => [q.id, q.answer])).toEqual([
      [5001, 'Hana'],
      [5003, null],
    ]);
  });

  const heading = (prompt: string, n?: number) =>
    `<ion-item class="ion-text-wrap">${n ? `<ion-badge color="dark" slot="start">${n}</ion-badge>` : ''}` +
    `<ion-label><core-format-text text="${prompt}"></core-format-text></ion-label></ion-item>`;
  const tick = (key: string, id: number) =>
    `<ion-item><ion-label><core-format-text text="Choice ${id}"></core-format-text></ion-label>` +
    `<ion-checkbox value="${id}" [(ngModel)]="CONTENT_OTHERDATA.${key}_${id}"></ion-checkbox></ion-item>`;

  it('reads unnumbered questions and skips headings without a widget', () => {
    const essay = '<ion-item><ion-label></ion-label><ion-textarea [(ngModel)]="CONTENT_OTHERDATA.response_3_8001">';
    const body = `${heading('&lt;p&gt;Intro only&lt;/p&gt;')}${heading('&lt;p&gt;Plain question&lt;/p&gt;')}${essay}`;
    expect(parseQuestionnairePage(html(body), 1).questions).toEqual([
      expect.objectContaining({ id: 8001, number: null, type: 'essay', prompt: 'Plain question', required: false }),
    ]);
  });

  it('stays linear on a large form', () => {
    const choices = (i: number) => [1, 2, 3, 4, 5].map((c) => tick(`response_5_${i}`, i * 10 + c)).join('');
    const one = (i: number) => `${heading(`${i}. Q${i}`, i)}<ion-list>${choices(i)}</ion-list>`;
    const body = Array.from({ length: 90 }, (_, i) => one(i + 1)).join('\n');
    const started = performance.now();
    const { questions } = parseQuestionnairePage(html(body), 1);
    expect(questions).toHaveLength(90);
    expect(questions[89]).toMatchObject({ prompt: 'Q90', number: '90', type: 'checkbox' });
    expect(questions[89]?.choices).toHaveLength(5);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

// ------------------------------------------------------------------ getActivity

type ViewArgs = Record<string, string>;

const argsOf = (params: Record<string, unknown>): ViewArgs =>
  Object.fromEntries((params.args as Array<{ name: string; value: string }>).map((a) => [a.name, a.value]));

const views = (calls: FakeCall[]) =>
  calls.filter((c) => c.fn === 'tool_mobile_get_content').map((c) => argsOf(c.params));

const OPEN_WINDOW = { open: '2026-11-12T08:50:00+09:00', close: '2026-11-19T13:00:00+09:00' };

function context(pages: (a: ViewArgs) => unknown, dates = OPEN_WINDOW) {
  return makeFakeContext({
    core_course_get_course_module: { cm: { id: 101, course: 99, modname: 'questionnaire', instance: 9101, name: 'x' } },
    core_course_get_contents: [
      {
        modules: [
          {
            id: 101,
            name: 'Session 3 report',
            modname: 'questionnaire',
            description: '<p>Please answer by Thursday.</p>',
            dates: [
              { label: 'Opens:', timestamp: ts(dates.open), dataid: 'timeopen' },
              { label: 'Closes:', timestamp: ts(dates.close), dataid: 'timeclose' },
            ],
          },
        ],
      },
    ],
    tool_mobile_get_content: (params: Record<string, unknown>) => pages(argsOf(params)),
  });
}

describe('getActivity (questionnaire)', () => {
  it('reads every page of an open questionnaire, read only', async () => {
    const { ctx, calls } = context((a) => {
      if (!a.action) return openIndex;
      return a.pagenum === '1' ? page1 : page2;
    });
    const q = (await getActivity(ctx, 101)) as QuestionnaireDetail;
    expect(q).toMatchObject({
      type: 'questionnaire',
      cmid: 101,
      courseName: '総合日本語３Ｘ',
      name: 'Session 3 report',
      description: 'Please answer by Thursday.',
      opensAt: '2026-11-12T08:50:00+09:00',
      closesAt: '2026-11-19T13:00:00+09:00',
      window: 'open',
      status: 'none',
      submissions: 0,
      canAnswer: true,
      answers: null,
      complete: true,
    });
    expect(q.questions.map((x) => x.id)).toEqual([5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5010]);
    expect(views(calls).map((v) => [v.action, v.pagenum])).toEqual([
      [undefined, undefined],
      ['respond', '1'],
      ['respond', '2'],
    ]);
    expect(views(calls).every((v) => v.action === undefined || v.action === 'respond')).toBe(true);
  });

  it('shows a submitted response from the review page (one call for all pages)', async () => {
    const ended = { open: '2026-10-01T08:50:00+09:00', close: '2026-10-08T13:00:00+09:00' };
    const { ctx, calls } = context((a) => (a.action === 'review' ? review : closedAnswered), ended);
    const q = (await getActivity(ctx, 101)) as QuestionnaireDetail;
    expect(q).toMatchObject({
      window: 'closed',
      status: 'submitted',
      submittedAt: '2026-10-08T11:11:00+09:00',
      submissions: 1,
      canAnswer: false,
      answers: 'submitted',
      complete: true,
    });
    expect(q.notice).toContain('終了しました');
    expect(q.questions.find((x) => x.id === 5006)?.answer).toBe('Osaka');
    expect(views(calls).filter((v) => v.action === 'review')).toHaveLength(1);
  });

  it('opens a saved draft with its response id and answers', async () => {
    const { ctx, calls } = context((a) => (a.action ? respondDraft : draftIndex));
    const q = (await getActivity(ctx, 101)) as QuestionnaireDetail;
    expect(q).toMatchObject({ status: 'draft', canAnswer: true, answers: 'draft', complete: true });
    expect(q.questions[0]?.answer).toBe('Hana');
    expect(views(calls)[1]).toMatchObject({ action: 'respond', pagenum: '1', rid: '9003' });
  });

  it('shows no questions before the questionnaire opens', async () => {
    const later = { open: '2026-11-19T08:50:00+09:00', close: '2026-11-26T13:00:00+09:00' };
    const { ctx, calls } = context(() => notOpen, later);
    const q = (await getActivity(ctx, 101)) as QuestionnaireDetail;
    expect(q).toMatchObject({ window: 'not-open', status: 'none', canAnswer: false, questions: [], complete: true });
    expect(q.notice).toContain('開始されません');
    expect(views(calls)).toHaveLength(1);
  });

  it('marks the questions incomplete when a page is refused', async () => {
    const { ctx } = context((a) => {
      if (!a.action) return openIndex;
      if (a.pagenum === '1') return page1;
      throw new MoodleError('No access', 'nopermission');
    });
    const q = (await getActivity(ctx, 101)) as QuestionnaireDetail;
    expect(q.complete).toBe(false);
    expect(q.questions).toHaveLength(6);
  });

  it('takes the index on a later page as a refusal and shows its notice', async () => {
    const { ctx } = context((a) => {
      if (!a.action) return openIndex;
      return a.pagenum === '1' ? page1 : closed;
    });
    const q = (await getActivity(ctx, 101)) as QuestionnaireDetail;
    expect(q).toMatchObject({
      complete: false,
      canAnswer: false,
      notice: 'Closed on Thursday, 15 October 2026, 11:59 PM.',
    });
    expect(q.questions).toHaveLength(6);
  });

  it('shows no form when the first page comes back as the index', async () => {
    const { ctx } = context((a) => (a.action ? closed : openIndex));
    const q = (await getActivity(ctx, 101)) as QuestionnaireDetail;
    expect(q).toMatchObject({ questions: [], complete: false, canAnswer: false });
    expect(q.notice).toContain('Closed on');
    expect(q).not.toHaveProperty('rid');
  });
});
