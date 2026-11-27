import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getActivity } from '../../src/core/services/activity';
import {
  parseWebQuestionnaireIndex,
  parseWebQuestionnairePage,
  parseWebQuestionnaireResponse,
} from '../../src/core/services/submission/questionnaire-web';
import type { QuestionnaireDetail } from '../../src/core/types';
import { makeFakeContext } from '../helpers/fake-context-be3';
import { fixture, makeWebApi } from './web-channel';

vi.mock('../../src/core/services/courses', () => ({
  listAllCourses: vi.fn(async () => [{ id: 99101, name: '総合日本語３Ｘ' }]),
}));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T12:00:00+09:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

const BASE = 'https://wsdmoodle.waseda.jp';
const VIEW = '/mod/questionnaire/view.php?id=7101';
const REPORT = '/mod/questionnaire/myreport.php?instance=9101&user=7001&byresponse=1&action=vresp';
const PRINT_BLANK = '/mod/questionnaire/print.php?qid=9101&rid=0&courseid=99101&sec=1';

describe('parseWebQuestionnaireIndex', () => {
  it('reads a submitted response that may be answered again (no count on the page)', () => {
    expect(parseWebQuestionnaireIndex(fixture('questionnaire-view-ja.html'), BASE)).toEqual({
      state: { status: 'submitted', canContinue: true, submittedAt: null, graded: false, note: null },
      canAnswer: true,
      draft: false,
      draftRid: null,
      submissionIds: [],
      responses: 1,
      exact: false,
      reviewPath: REPORT,
      notice: null,
    });
  });

  it('reads the resume link as a saved draft and a closed page as nothing to do, with its notice', () => {
    const draft = parseWebQuestionnaireIndex(fixture('questionnaire-view-draft-en.html'), BASE);
    expect(draft).toMatchObject({ draft: true, canAnswer: true, responses: 0, state: { status: 'draft' } });
    const closed = parseWebQuestionnaireIndex(fixture('questionnaire-view-closed-en.html'), BASE);
    expect(closed).toMatchObject({ state: null, canAnswer: false, draft: false, responses: 0 });
    expect(closed.notice).toBe('This questionnaire closed on Thursday, 15 October 2026, 11:59 PM.');
  });
});

describe('parseWebQuestionnairePage', () => {
  it('maps every question by its inputs, with the saved answers and the form state', () => {
    const page = parseWebQuestionnairePage(fixture('questionnaire-form-ja.html'), BASE);
    const qs = page.questions.map((q) => q.question);
    expect(qs.map((q) => [q.id, q.number, q.type, q.required])).toEqual([
      [5001, '1', 'text', true],
      [5002, '2', 'essay', true],
      [5003, '3', 'radio', true],
      [5004, '4', 'checkbox', false],
      [5005, '5', 'yesno', false],
      [5006, '6', 'dropdown', false],
      [5007, '7', 'rate', true],
    ]);
    expect(qs[0]).toMatchObject({ page: 1, prompt: 'クラスでのニックネーム', answer: null });
    expect(qs[2]?.choices).toEqual([
      { id: '7001', label: '図書館', otherText: false },
      { id: '7002', label: 'カフェテリア', otherText: false },
      { id: '7003', label: 'その他:', otherText: true },
    ]);
    expect(qs[3]?.choices.map((c) => [c.id, c.otherText])).toEqual([
      ['7101', false],
      ['7102', false],
      ['7104', true],
    ]);
    // the optional yes/no question's "no answer" radio (value '', checked) is no choice and no answer
    expect(qs[4]?.choices).toEqual([
      { id: 'y', label: 'はい', otherText: false },
      { id: 'n', label: 'いいえ', otherText: false },
    ]);
    expect(page.questions[4]?.inputs.names).toEqual(['q5005']);
    expect(qs[5]?.choices.map((c) => c.label)).toEqual(['アジア', 'ヨーロッパ', 'その他']);
    expect(qs[6]).toMatchObject({
      choices: [
        { id: '7301', label: '内容', otherText: false },
        { id: '7302', label: '進み方', otherText: false },
      ],
      scale: [
        { value: '1', label: '低い' },
        { value: '2', label: '普通' },
        { value: '3', label: '高い' },
      ],
    });
    expect(qs.map((q) => q.answer)).toEqual([null, null, 'カフェテリア', 'アプリ', null, 'ヨーロッパ', null]);
    expect(page).toMatchObject({
      unsupported: [],
      action: '/mod/questionnaire/complete.php?id=7101',
      buttons: { resume: '後で続けるために保存する', submit: 'アンケートを送信する' },
      pageNumber: 1,
      rid: 0,
      ids: { questionnaireId: 9101, surveyId: 9201 },
      printPath: PRINT_BLANK,
      notice: null,
      thanked: false,
    });
    expect(page.fields.get('sesskey')).toBe('fakesesskey01');
  });

  it('reads an optional radio list with its "no answer" radio as the choices without it', () => {
    const end = '<!-- End HTML generated from question_radio template. -->';
    const blank =
      '<div><input id="auto-rb0009" value="" name="q5003" type="radio" checked="checked" aria-label="x">' +
      `<label for="auto-rb0009">未回答</label></div>\n${end}`;
    const html = fixture('questionnaire-form-ja.html').replace(end, blank);
    expect(html).toContain('id="auto-rb0009"');
    const q = parseWebQuestionnairePage(html, BASE).questions[2]?.question;
    expect(q).toMatchObject({ type: 'radio', answer: 'カフェテリア' });
    expect(q?.choices.map((c) => c.id)).toEqual(['7001', '7002', '7003']);
  });

  it('numbers the questions of the printable copy by its page markers (one fieldset per question)', () => {
    const qs = parseWebQuestionnairePage(fixture('questionnaire-print-en.html'), BASE).questions.map((q) => q.question);
    expect(qs.map((q) => [q.id, q.page, q.type, q.required])).toEqual([
      [5011, 1, 'text', true],
      [5012, 1, 'yesno', false],
      [5013, 2, 'essay', true],
      [5014, 2, 'rate', false],
    ]);
    const three = fixture('questionnaire-print-en.html').replace(
      '<fieldset id="qn-5014"',
      '<div class="surveyPage">Page 3</div><fieldset id="qn-5014"',
    );
    expect(parseWebQuestionnairePage(three, BASE).questions.map((q) => q.question.page)).toEqual([1, 1, 2, 3]);
  });

  it('reads a submitted response from the read-only responses page, in words (no choice ids there)', () => {
    const qs = parseWebQuestionnaireResponse(fixture('questionnaire-myreport-ja.html'));
    expect(qs.map((q) => [q.id, q.number, q.type, q.answer])).toEqual([
      [5001, '1', 'text', 'はなこ'],
      [5002, '2', 'essay', '敬語の使い方 & 作文'],
      [5003, '3', 'radio', 'その他: 自宅'],
      [5004, '4', 'checkbox', '教科書; アプリ'],
      [5005, '5', 'yesno', 'いいえ'],
      [5007, '7', 'rate', '内容: 高い; 進み方: 普通'],
    ]);
    expect(qs[2]).toMatchObject({ page: 1, prompt: 'よく勉強する場所', choices: [], scale: [], range: null });
    // the same page has no form inputs: read as a form it holds no question
    expect(parseWebQuestionnairePage(fixture('questionnaire-myreport-ja.html'), BASE).questions).toEqual([]);
  });

  it('tells the thank-you page from a form page and from a page with a notice', () => {
    expect(parseWebQuestionnairePage(fixture('questionnaire-thanks-ja.html'), BASE)).toMatchObject({
      thanked: true,
      action: null,
      questions: [],
    });
    const refused = fixture('questionnaire-thanks-ja.html').replace(
      '<h3>',
      '<div class="notifyproblem">このアンケートは終了しました。</div><h3>',
    );
    expect(parseWebQuestionnairePage(refused, BASE).thanked).toBe(false);
  });

  it('marks a question with inputs it does not map as unsupported', () => {
    const odd = fixture('questionnaire-form-ja.html').replace(
      'type="text" size="20" name="q5001"',
      'type="color" name="q5001"',
    );
    const page = parseWebQuestionnairePage(odd, BASE);
    expect(page.questions[0]?.question.type).toBe('other');
    expect(page.unsupported).toEqual(['Q1 (question_id 5001)']);
  });
});

function setup(pages: Record<string, string>) {
  const api = makeWebApi({
    pages,
    handlers: {
      core_course_get_course_module: {
        cm: { id: 7101, course: 99101, modname: 'questionnaire', instance: 7101, name: 'クラス前アンケート' },
      },
      core_course_get_contents: [{ modules: [{ id: 7101, name: 'クラス前アンケート', dates: [] }] }],
    },
  });
  const { ctx } = makeFakeContext({}, { lang: 'ja' });
  return { api, ctx: { ...ctx, moodle: async () => api } };
}

describe('getActivity questionnaire on the web channel', () => {
  it('shows a submitted response read from the responses page itself (no further page)', async () => {
    const { api, ctx } = setup({
      [VIEW]: fixture('questionnaire-view-ja.html'),
      [REPORT]: fixture('questionnaire-myreport-ja.html'),
    });
    const q = (await getActivity(ctx, 7101)) as QuestionnaireDetail;
    expect(q).toMatchObject({ status: 'submitted', submissions: 1, canAnswer: true, answers: 'submitted' });
    expect(q.questions).toHaveLength(6);
    expect(api.pageCalls).toEqual([`GET ${VIEW}`, `GET ${REPORT}`]);
    expect(api.calls.find((c) => c.fn === 'core_course_get_contents')?.hint).toEqual({ cmid: 7101 });
  });

  it('reads a multi-page draft: page 1 with its answers, the later pages from the printable blank copy', async () => {
    const { api, ctx } = setup({
      [VIEW]: fixture('questionnaire-view-draft-en.html'),
      '/mod/questionnaire/complete.php?id=7101&resume=1': fixture('questionnaire-form-page1-en.html'),
      [PRINT_BLANK]: fixture('questionnaire-print-en.html'),
    });
    const q = (await getActivity(ctx, 7101)) as QuestionnaireDetail;
    expect(q).toMatchObject({ status: 'draft', answers: 'draft', complete: true });
    expect(q.questions.map((x) => [x.id, x.page, x.type, x.answer])).toEqual([
      [5011, 1, 'text', 'Hana'],
      [5012, 1, 'yesno', 'Yes'],
      [5013, 2, 'essay', null],
      [5014, 2, 'rate', null],
    ]);
    expect(api.pageCalls).toHaveLength(3);
  });

  it('keeps a multi-page form incomplete when the printable copy is not there', async () => {
    const { ctx } = setup({
      [VIEW]: fixture('questionnaire-view-draft-en.html'),
      '/mod/questionnaire/complete.php?id=7101&resume=1': fixture('questionnaire-form-page1-en.html'),
    });
    const q = (await getActivity(ctx, 7101)) as QuestionnaireDetail;
    expect(q.complete).toBe(false);
    expect(q.questions.map((x) => x.id)).toEqual([5011, 5012]);
  });

  it('shows no questions for a closed questionnaire', async () => {
    const { ctx } = setup({ [VIEW]: fixture('questionnaire-view-closed-en.html') });
    const q = (await getActivity(ctx, 7101)) as QuestionnaireDetail;
    expect(q).toMatchObject({ status: 'none', canAnswer: false, questions: [] });
    expect(q.notice).toContain('closed');
  });
});
