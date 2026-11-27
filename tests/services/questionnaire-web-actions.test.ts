import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebPage, WebRequest } from '../../src/core/moodle/web/types';
import { confirmAction, prepareQuestionnaire } from '../../src/core/services/actions';
import type { QuestionnaireAnswerInput } from '../../src/core/services/actions/questionnaire';
import { listAllCourses } from '../../src/core/services/courses';
import { createTestContext } from '../helpers/fake-context-be4';
import { makeFakeWebSession } from '../helpers/fake-web-session';
import { fixture, pageOf, redirectTo } from './web-channel';

vi.mock('../../src/core/services/courses', () => ({ listAllCourses: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T12:00:00+09:00'));
  vi.mocked(listAllCourses).mockResolvedValue([{ id: 99101, name: '総合日本語３Ｘ' } as never]);
});
afterEach(() => {
  vi.useRealTimers();
});

const VIEW = '/mod/questionnaire/view.php?id=7101';
const FORM = '/mod/questionnaire/complete.php?id=7101';
const RESUME = `${FORM}&resume=1`;
const PRINT_BLANK = '/mod/questionnaire/print.php?qid=9101&rid=0&courseid=99101&sec=1';
const SUBMITTED_VIEW = fixture('questionnaire-view-ja.html');
const OPEN_VIEW = SUBMITTED_VIEW.replace(/<a href="[^"]*myreport\.php[^"]*"[^>]*>[^<]*<\/a>/, '');
const DRAFT_VIEW = fixture('questionnaire-view-draft-en.html');
/** A questionnaire taken once whose responses the user may not view: no answer link, no responses link. */
const DONE_VIEW = OPEN_VIEW.replace(/<a href="[^"]*complete\.php[^"]*"[^>]*>[^<]*<\/a>/, '');
const THANKS = fixture('questionnaire-thanks-ja.html');

type PostHandler = (form: URLSearchParams) => WebPage;

/** The web channel with the questionnaire's pages; POSTs to the form go to `post`, the index changes after one. */
function setup(opts: { views: [string, string]; form: string; post: PostHandler; print?: string }) {
  const t = createTestContext();
  const posts: URLSearchParams[] = [];
  const post = (req: WebRequest) => {
    const form = req.form ?? new URLSearchParams();
    posts.push(form);
    return opts.post(form);
  };
  const web = makeFakeWebSession({
    pages: {
      [VIEW]: () => pageOf(VIEW, posts.length ? opts.views[1] : opts.views[0]),
      [FORM]: (req: WebRequest) => (req.method === 'POST' ? post(req) : pageOf(FORM, opts.form)),
      [RESUME]: () => pageOf(RESUME, opts.form),
      ...(opts.print ? { [PRINT_BLANK]: opts.print } : {}),
    },
  });
  Object.assign(t.moodle, { channel: 'web', web });
  t.moodle.handlers.core_course_get_course_module = {
    cm: { id: 7101, course: 99101, modname: 'questionnaire', instance: 7101, name: 'クラス前アンケート' },
  };
  t.moodle.handlers.core_course_get_contents = [{ modules: [{ id: 7101, name: 'クラス前アンケート', dates: [] }] }];
  return { ...t, web, posts };
}

const JA_ANSWERS: QuestionnaireAnswerInput[] = [
  { questionId: 5001, text: 'Hana' },
  { questionId: 5002, text: '敬語を練習したい' },
  { questionId: 5003, choiceIds: ['7003'], otherText: '自宅' },
  { questionId: 5004, choiceIds: [7101, '7104'], otherText: 'ポッドキャスト' },
  { questionId: 5005, choiceIds: ['y'] },
  { questionId: 5006, choiceIds: ['7201'] },
  {
    questionId: 5007,
    rating: [
      { rowId: 7301, value: 3 },
      { rowId: '7302', value: '普通' },
    ],
  },
];

describe('questionnaire_submit on the web channel', () => {
  it('posts the single page like the browser: the form fields, the answers in its own names, submit', async () => {
    const { ctx, posts, web } = setup({
      views: [OPEN_VIEW, SUBMITTED_VIEW],
      form: fixture('questionnaire-form-ja.html'),
      post: () => redirectTo(VIEW),
    });
    const preview = await prepareQuestionnaire(ctx, { cmid: 7101, answers: JA_ANSWERS });
    expect(preview.details).toContain('Q3 よく勉強する場所: その他: 自宅');
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: 'Answers submitted.' });
    expect(posts).toHaveLength(1);
    const sent = [...(posts[0] ?? [])];
    expect(sent).toEqual([
      ['referer', ''],
      ['a', '9101'],
      ['sid', '9201'],
      ['rid', '0'],
      ['sec', '1'],
      ['end', '0'],
      ['sesskey', 'fakesesskey01'],
      ['q5001', 'Hana'],
      ['q5002', '敬語を練習したい'],
      ['q5003', 'other_7003'],
      ['q5003_o7003', '自宅'],
      ['q5004[7101]', '7101'],
      ['q5004[o7104]', '1'],
      ['q5004_o7104', 'ポッドキャスト'],
      ['q5005', 'y'],
      ['q5006', '7201'],
      ['q5007_7301', '3'],
      ['q5007_7302', '2'],
      ['submit', 'アンケートを送信する'],
    ]);
    // the saved choices of the page (q5003 = 7002, q5004[7102], q5006 = 7202) and the checked "no answer" radio of
    // the optional yes/no question (q5005 = '') are replaced, not sent along
    expect(web.calls.filter((c) => c.startsWith('POST'))).toEqual([`POST ${FORM}`]);
  });

  it('saves page 1 with next, sends the last page with submit, continuing the saved draft', async () => {
    const page2 = fixture('questionnaire-form-page2-en.html');
    const { ctx, posts } = setup({
      views: [DRAFT_VIEW, SUBMITTED_VIEW],
      form: fixture('questionnaire-form-page1-en.html'),
      print: fixture('questionnaire-print-en.html'),
      post: (form) => (form.has('next') ? pageOf(FORM, page2) : redirectTo(VIEW)),
    });
    const answers: QuestionnaireAnswerInput[] = [
      { questionId: 5011, text: 'Hanako' },
      { questionId: 5012, choiceIds: ['n'] },
      { questionId: 5013, text: 'Keigo' },
      { questionId: 5014, rating: [{ rowId: 7401, value: 'High' }] },
    ];
    const preview = await prepareQuestionnaire(ctx, { cmid: 7101, answers });
    expect(preview.warnings).toContain('Replaces the answers of the saved draft.');
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: 'Answers submitted.' });
    const [first, last] = posts.map((f) => Object.fromEntries(f));
    expect(first).toMatchObject({ rid: '9310', sec: '1', q5011: 'Hanako', q5012: 'n', next: 'Next Page >>' });
    expect(first).not.toHaveProperty('q5013');
    expect(first).not.toHaveProperty('submit');
    expect(last).toMatchObject({ sec: '2', q5013: 'Keigo', q5014_7401: '3', submit: 'Submit questionnaire' });
    expect(last).not.toHaveProperty('q5011');
  });

  it('saves a draft with the resume button and checks the resume link afterwards', async () => {
    const { ctx, posts } = setup({
      views: [OPEN_VIEW, DRAFT_VIEW],
      form: fixture('questionnaire-form-ja.html'),
      post: () => redirectTo(VIEW),
    });
    const preview = await prepareQuestionnaire(ctx, { cmid: 7101, answers: JA_ANSWERS, final: false });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: 'Answers saved as a draft; submit them in Moodle.' });
    expect(Object.fromEntries(posts[0] ?? [])).toMatchObject({ resume: '後で続けるために保存する' });
    expect(posts[0]?.has('submit')).toBe(false);
  });

  it('stops when Moodle shows the same page again with its error', async () => {
    const page1 = fixture('questionnaire-form-page1-en.html');
    const error = '<div class="notifyproblem">Please answer the required question #1.</div>';
    const refused = page1.replace('<form', `${error}<form`);
    const { ctx, posts } = setup({
      views: [DRAFT_VIEW, DRAFT_VIEW],
      form: page1,
      print: fixture('questionnaire-print-en.html'),
      post: () => pageOf(FORM, refused),
    });
    const answers: QuestionnaireAnswerInput[] = [
      { questionId: 5011, text: 'Hanako' },
      { questionId: 5013, text: 'Keigo' },
    ];
    const preview = await prepareQuestionnaire(ctx, { cmid: 7101, answers });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Moodle did not accept page 1: Please answer the required question #1.'),
    });
    expect(posts).toHaveLength(1);
  });

  it('refuses a form with a question it does not map, and a draft where the form offers none', async () => {
    const odd = fixture('questionnaire-form-ja.html').replace(
      'type="text" size="20" name="q5001"',
      'type="color" name="q5001"',
    );
    const one = setup({ views: [OPEN_VIEW, OPEN_VIEW], form: odd, post: () => redirectTo(VIEW) });
    await expect(prepareQuestionnaire(one.ctx, { cmid: 7101, answers: JA_ANSWERS.slice(1) })).rejects.toThrow(
      'This questionnaire has questions this server cannot answer (Q1 (question_id 5001)); use Moodle.',
    );
    const noDraft = fixture('questionnaire-form-ja.html').replace(/<input type="submit" name="resume"[^>]*>/, '');
    const two = setup({ views: [OPEN_VIEW, OPEN_VIEW], form: noDraft, post: () => redirectTo(VIEW) });
    await expect(prepareQuestionnaire(two.ctx, { cmid: 7101, answers: JA_ANSWERS, final: false })).rejects.toThrow(
      'This questionnaire cannot be saved as a draft',
    );
    expect(one.posts).toHaveLength(0);
  });

  it('confirms by the thank-you page where the index links no responses (responses not viewable)', async () => {
    const { ctx, posts } = setup({
      views: [OPEN_VIEW, DONE_VIEW],
      form: fixture('questionnaire-form-ja.html'),
      post: () => pageOf(FORM, THANKS),
    });
    const preview = await prepareQuestionnaire(ctx, { cmid: 7101, answers: JA_ANSWERS });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: 'Answers submitted.' });
    expect(posts).toHaveLength(1);
  });

  it('does not take an earlier response on the index for a repeat submission; the thank-you page does', async () => {
    const unconfirmed = setup({
      views: [SUBMITTED_VIEW, SUBMITTED_VIEW],
      form: fixture('questionnaire-form-ja.html'),
      post: () => redirectTo(VIEW),
    });
    const first = await prepareQuestionnaire(unconfirmed.ctx, { cmid: 7101, answers: JA_ANSWERS });
    expect(first.warnings).toContain('A response was already submitted; this adds another one.');
    expect(await confirmAction(unconfirmed.ctx, first.actionId, 'mcp')).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Moodle did not confirm the answers'),
    });
    const thanked = setup({
      views: [SUBMITTED_VIEW, SUBMITTED_VIEW],
      form: fixture('questionnaire-form-ja.html'),
      post: () => pageOf(FORM, THANKS),
    });
    const again = await prepareQuestionnaire(thanked.ctx, { cmid: 7101, answers: JA_ANSWERS });
    expect(await confirmAction(thanked.ctx, again.actionId, 'mcp')).toMatchObject({
      status: 'executed',
      message: 'Answers submitted.',
    });
  });

  it('reports the notice of a refused last page shown without the form', async () => {
    const closed = THANKS.replace('<h3>', '<div class="notifyproblem">This questionnaire is closed.</div><h3>');
    const { ctx } = setup({
      views: [OPEN_VIEW, OPEN_VIEW],
      form: fixture('questionnaire-form-ja.html'),
      post: () => pageOf(FORM, closed),
    });
    const preview = await prepareQuestionnaire(ctx, { cmid: 7101, answers: JA_ANSWERS });
    expect(await confirmAction(ctx, preview.actionId, 'mcp')).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('(This questionnaire is closed.)'),
    });
  });
});
