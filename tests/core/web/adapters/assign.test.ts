import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CallHint, MoodleChannel } from '../../../../src/core/context';
import { MoodleError } from '../../../../src/core/errors';
import { assignFunctions } from '../../../../src/core/moodle/web/adapters/assign';
import type { WebPage, WebRequest, WebSession } from '../../../../src/core/moodle/web/types';
import { confirmAction } from '../../../../src/core/services/actions/confirm';
import { savePreview } from '../../../../src/core/services/actions/shared';
import { mapAssign, type RawAssign, type RawAssignStatus } from '../../../../src/core/services/activity/assign';
import { parseAssignStatus } from '../../../../src/core/services/submission/assign';
import { makeFakeContext } from '../../../helpers/fake-context';
import { makeFakeWebSession } from '../../../helpers/fake-web-session';

const BASE = 'https://wsdmoodle.waseda.jp';
const fixture = (name: string) => readFileSync(join(__dirname, '../../../fixtures/web', name), 'utf8');

/** Unix seconds of a Tokyo wall-clock time. */
const jst = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - 9, mi) / 1000;

const view = (cmid: number, action?: string) => `/mod/assign/view.php?id=${cmid}${action ? `&action=${action}` : ''}`;

function run(web: WebSession, fn: string, params: Record<string, unknown>, hint: CallHint = {}): Promise<unknown> {
  const adapter = assignFunctions[fn];
  if (!adapter) throw new Error(`no adapter for ${fn}`);
  return adapter(web, params, hint);
}

const STATEMENT_OK = { acceptsubmissionstatement: true };

const INFO = { courseId: 99100, courseName: '総合日本語３Ｘ', url: `${BASE}${view(99101)}`, lang: 'ja' };

function firstAssignment(res: unknown): RawAssign {
  const courses = (res as { courses: Array<{ assignments: RawAssign[] }> }).courses;
  const a = courses[0]?.assignments[0];
  if (!a) throw new Error('no assignment');
  return a;
}

/** A form POST answered like Moodle: 303 = saved, otherwise the re-rendered page. */
function poster(answer: Partial<WebPage>) {
  const posted: URLSearchParams[] = [];
  const entry = (req: WebRequest): WebPage => {
    if (req.form) posted.push(req.form);
    return { url: `${BASE}/mod/assign/view.php`, status: 303, html: '', location: `${BASE}${view(99101)}`, ...answer };
  };
  return { posted, entry };
}

describe('mod_assign_get_assignments (web)', () => {
  it('reads one assignment from its view page and edit form (statement on the form = no draft stage)', async () => {
    const web = makeFakeWebSession({
      pages: {
        [view(99101)]: fixture('assign-view-new-ja.html'),
        [view(99101, 'editsubmission')]: fixture('assign-edit-ja.html'),
      },
    });
    const res = await run(web, 'mod_assign_get_assignments', { courseids: [99100] }, { cmid: 99101 });
    const a = firstAssignment(res);
    expect(a).toMatchObject({
      id: 99101,
      cmid: 99101,
      course: 99100,
      name: '最終レポート提出',
      introformat: 1,
      allowsubmissionsfromdate: jst(2026, 10, 2, 13, 10),
      duedate: jst(2026, 10, 8, 23, 59),
      submissiondrafts: 0,
      teamsubmission: 0,
      requiresubmissionstatement: 1,
    });
    expect(a.intro).toContain('レポートを提出してください。');
    expect(a.submissionstatement).toContain('提出物は自分自身の作品です。');
    expect(a.introattachments).toEqual([
      {
        filename: '課題.pdf',
        filepath: '/',
        fileurl: `${BASE}/pluginfile.php/99901/mod_assign/introattachment/0/%E8%AA%B2%E9%A1%8C.pdf`,
      },
    ]);
    expect(a.configs).toEqual([
      { plugin: 'onlinetext', subtype: 'assignsubmission', name: 'enabled', value: '1' },
      { plugin: 'file', subtype: 'assignsubmission', name: 'enabled', value: '1' },
      { plugin: 'file', subtype: 'assignsubmission', name: 'maxfilesubmissions', value: '3' },
      { plugin: 'file', subtype: 'assignsubmission', name: 'maxsubmissionsizebytes', value: '5242880' },
      { plugin: 'file', subtype: 'assignsubmission', name: 'filetypeslist', value: '.pdf,.docx,.doc' },
    ]);
    expect(web.calls).toEqual([`GET ${view(99101)}`, `GET ${view(99101, 'editsubmission')}`]);

    const detail = mapAssign(a, null, INFO);
    expect(detail).toMatchObject({
      instanceId: 99101,
      submissionTypes: ['onlinetext', 'file'],
      maxFiles: 3,
      maxFileBytes: 5242880,
      acceptedTypes: ['.pdf', '.docx', '.doc'],
      draftsEnabled: false,
      requiresStatement: true,
      statement: '提出物は自分自身の作品です。',
    });
    expect(detail.attachments.map((f) => f.name)).toEqual(['課題.pdf']);
  });

  it('reads the statement from the submit form when the assignment has a draft stage', async () => {
    const web = makeFakeWebSession({
      pages: {
        [view(99102)]: fixture('assign-view-draft-en.html'),
        [view(99102, 'editsubmission')]: fixture('assign-edit-en.html'),
        [view(99102, 'submit')]: fixture('assign-submit-en.html'),
      },
    });
    const a = firstAssignment(await run(web, 'mod_assign_get_assignments', { courseids: [99100] }, { cmid: 99102 }));
    expect(a).toMatchObject({
      name: 'Essay 1',
      allowsubmissionsfromdate: jst(2026, 10, 2, 13, 10),
      duedate: jst(2026, 10, 8, 23, 59),
      submissiondrafts: 1,
      requiresubmissionstatement: 1,
      submissionstatement: 'This submission is my own work.',
    });
    // inline intro images are not attachments; '*' accepts any type, -1 files = no limit
    expect(a.introattachments).toEqual([]);
    expect(a.configs).toEqual([
      { plugin: 'onlinetext', subtype: 'assignsubmission', name: 'enabled', value: '0' },
      { plugin: 'file', subtype: 'assignsubmission', name: 'enabled', value: '1' },
      { plugin: 'file', subtype: 'assignsubmission', name: 'maxsubmissionsizebytes', value: '10485760' },
      { plugin: 'file', subtype: 'assignsubmission', name: 'filetypeslist', value: '*' },
    ]);
    expect(mapAssign(a, null, INFO)).toMatchObject({ acceptedTypes: [], maxFiles: null, draftsEnabled: true });
  });

  it('leaves the draft stage unknown for a new attempt without a statement on the edit form', async () => {
    const web = makeFakeWebSession({
      pages: {
        [view(99101)]: fixture('assign-view-new-ja.html'),
        [view(99101, 'editsubmission')]: fixture('assign-edit-en.html'),
      },
    });
    const a = firstAssignment(await run(web, 'mod_assign_get_assignments', { courseids: [99100] }, { cmid: 99101 }));
    expect(a).toMatchObject({ submissiondrafts: null, requiresubmissionstatement: 0, submissionstatement: '' });
    // a draft stage would put the statement on the submit form: looked for, not offered here
    expect(web.calls).toEqual([
      `GET ${view(99101)}`,
      `GET ${view(99101, 'editsubmission')}`,
      `GET ${view(99101, 'submit')}`,
    ]);
    expect(mapAssign(a, null, INFO)).toMatchObject({ draftsEnabled: null, requiresStatement: false });
  });

  it('without an edit button reads only the view page; plugins come from the status table', async () => {
    const web = makeFakeWebSession({ pages: { [view(99103)]: fixture('assign-view-graded-ja.html') } });
    const a = firstAssignment(await run(web, 'mod_assign_get_assignments', { courseids: [99100] }, { cmid: 99103 }));
    expect(a).toMatchObject({ requiresubmissionstatement: 0, grade: 100, allowsubmissionsfromdate: null });
    expect(a.configs).toEqual([{ plugin: 'onlinetext', subtype: 'assignsubmission', name: 'enabled', value: '1' }]);
    expect(web.calls).toEqual([`GET ${view(99103)}`]);
  });

  it('answers no assignment when the cmid belongs to another course', async () => {
    const web = makeFakeWebSession({ pages: { [view(99103)]: fixture('assign-view-graded-ja.html') } });
    const res = await run(web, 'mod_assign_get_assignments', { courseids: [55555] }, { cmid: 99103 });
    expect(res).toEqual({ courses: [], warnings: [] });
  });

  it('lists a course from the activity overview without a hint (id/cmid/name/duedate)', async () => {
    const overview = `<table><tbody>
      <tr data-mdl-overview-cmid="99101">
        <td data-mdl-overview-item="name" data-mdl-overview-value="Essay 1">Essay 1</td>
        <td data-mdl-overview-item="duedate" data-mdl-overview-value="1791471540">8 Oct</td></tr>
      <tr data-mdl-overview-cmid="99102">
        <td data-mdl-overview-item="name" data-mdl-overview-value="Essay 2">Essay 2</td>
        <td data-mdl-overview-item="duedate" data-mdl-overview-value="">-</td></tr>
    </tbody></table>`;
    const web = makeFakeWebSession({ pages: { '/course/overview.php?id=99100&expand[]=assign': overview } });
    const res = await run(web, 'mod_assign_get_assignments', { courseids: [99100] });
    expect(res).toEqual({
      courses: [
        {
          id: 99100,
          assignments: [
            { id: 99101, cmid: 99101, course: 99100, name: 'Essay 1', duedate: 1791471540 },
            { id: 99102, cmid: 99102, course: 99100, name: 'Essay 2', duedate: 0 },
          ],
        },
      ],
      warnings: [],
    });
  });
});

describe('mod_assign_get_submission_status (web)', () => {
  const status = async (file: string, cmid: number) => {
    const web = makeFakeWebSession({ pages: { [view(cmid)]: fixture(file) } });
    return (await run(web, 'mod_assign_get_submission_status', { assignid: cmid })) as RawAssignStatus;
  };

  it('new (ja): no class on the status cell, editable, nothing to submit', async () => {
    const s = await status('assign-view-new-ja.html', 99101);
    expect(s.lastattempt).toMatchObject({
      submission: { status: 'new', timemodified: null, plugins: [] },
      canedit: true,
      cansubmit: false,
      locked: false,
      gradingstatus: 'notgraded',
      extensionduedate: null,
    });
    expect(s.feedback).toBeUndefined();
    expect(parseAssignStatus(s)).toMatchObject({ status: 'none', canContinue: true, graded: false });
  });

  it('draft (en): online text in full, files with WS-style pluginfile URLs and times', async () => {
    const s = await status('assign-view-draft-en.html', 99102);
    const sub = s.lastattempt?.submission;
    expect(sub?.status).toBe('draft');
    expect(sub?.timemodified).toBe(jst(2026, 10, 5, 9, 30));
    const text = sub?.plugins?.find((p) => p.type === 'onlinetext')?.editorfields?.[0];
    expect(text?.name).toBe('onlinetext');
    expect(text?.text).toContain('My hobby is hiking in the mountains.');
    expect(text?.text).toContain('nested');
    expect(text?.text).not.toContain('expandsummaryicon');
    expect(sub?.plugins?.find((p) => p.type === 'file')?.fileareas).toEqual([
      {
        area: 'submission_files',
        files: [
          {
            filename: 'essay draft.pdf',
            filepath: '/',
            fileurl: `${BASE}/pluginfile.php/99902/assignsubmission_file/submission_files/88002/essay%20draft.pdf`,
            timemodified: jst(2026, 10, 5, 9, 30),
          },
          {
            filename: 'notes.docx',
            filepath: '/',
            fileurl: `${BASE}/pluginfile.php/99902/assignsubmission_file/submission_files/88002/notes.docx`,
            timemodified: jst(2026, 10, 5, 9, 28),
          },
        ],
      },
    ]);
    expect(s.lastattempt).toMatchObject({ canedit: true, cansubmit: true, gradingstatus: 'notgraded' });
    expect(parseAssignStatus(s)).toMatchObject({ status: 'draft', note: 'submit button not pressed' });
  });

  it('submitted and graded (ja): extension, feedback grade, comments and files', async () => {
    const s = await status('assign-view-graded-ja.html', 99103);
    expect(s.lastattempt).toMatchObject({
      submission: { status: 'submitted', timemodified: jst(2026, 10, 8, 20, 26) },
      canedit: false,
      gradingstatus: 'graded',
      extensionduedate: jst(2026, 10, 10, 23, 59),
    });
    expect(s.feedback).toMatchObject({
      gradeddate: jst(2026, 10, 11, 10, 10),
      grade: { grade: '85.00', timemodified: jst(2026, 10, 11, 10, 10) },
    });
    expect(s.feedback?.gradefordisplay).toContain('85.00');
    expect(s.feedback?.plugins).toEqual([
      { type: 'comments', editorfields: [{ name: 'comments', text: '<p>よく書けました。</p>', format: 1 }] },
      {
        type: 'file',
        fileareas: [
          {
            area: 'feedback_files',
            files: [
              {
                filename: 'comments.pdf',
                filepath: '/',
                fileurl: `${BASE}/pluginfile.php/99903/assignfeedback_file/feedback_files/66003/comments.pdf`,
              },
            ],
          },
        ],
      },
    ]);
    const detail = mapAssign({ id: 99103, cmid: 99103, course: 99100, name: 'x' }, s, INFO);
    expect(detail.feedback?.grade).toMatch(/^85\.00\s\/\s100\.00$/);
    expect(detail.feedback?.comments).toBe('よく書けました。');
    expect(detail.feedback?.files.map((f) => f.url)).toEqual([
      `${BASE}/webservice/pluginfile.php/99903/assignfeedback_file/feedback_files/66003/comments.pdf`,
    ]);
    expect(detail.submission).toMatchObject({ status: 'submitted', onlineText: 'ありません。', canEdit: false });
    expect(parseAssignStatus(s)).toMatchObject({ status: 'submitted', graded: true, canContinue: false });
  });

  it('graded (en): locked, late, full feedback comment', async () => {
    const s = await status('assign-view-graded-en.html', 99103);
    expect(s.lastattempt).toMatchObject({
      submission: { status: 'submitted', timemodified: jst(2026, 10, 9, 0, 59), plugins: [] },
      locked: true,
      gradingstatus: 'graded',
      extensionduedate: null,
    });
    expect(s.feedback).toMatchObject({ gradeddate: jst(2026, 10, 11, 10, 10), grade: { grade: '7.50' } });
    const comment = s.feedback?.plugins?.[0]?.editorfields?.[0]?.text;
    expect(comment).toBe('<p>Good work, Taro. Cite your sources next time.</p>');
  });

  it("refuses another user's submission", async () => {
    const web = makeFakeWebSession({ pages: { [view(99101)]: fixture('assign-view-new-ja.html') } });
    const other = run(web, 'mod_assign_get_submission_status', { assignid: 99101, userid: 4242 });
    await expect(other).rejects.toBeInstanceOf(MoodleError);
    expect(web.calls).toEqual([]);
  });
});

describe('mod_assign_save_submission (web)', () => {
  const edit = view(99101, 'editsubmission');
  const session = (post: ReturnType<typeof poster>, form = 'assign-edit-ja.html') =>
    makeFakeWebSession({ pages: { [edit]: fixture(form), '/mod/assign/view.php': post.entry } });

  it('posts the fresh edit form with the text, the draft and the accepted statement (303 = saved)', async () => {
    const post = poster({});
    const web = session(post);
    const res = await run(web, 'mod_assign_save_submission', {
      assignmentid: 99101,
      plugindata: { onlinetext_editor: { text: '<p>完成版</p>', format: 1, itemid: 0 }, files_filemanager: 770001 },
      ...STATEMENT_OK,
    });
    expect(res).toEqual([]);
    expect(web.calls).toEqual([`GET ${edit}`, 'POST /mod/assign/view.php']);
    const body = Object.fromEntries(post.posted[0] ?? []);
    expect(body).toMatchObject({
      id: '99101',
      action: 'savesubmission',
      sesskey: 'fakesesskey01',
      lastmodified: '1791986556',
      _qf__mod_assign_submission_form: '1',
      'onlinetext_editor[text]': '<p>完成版</p>',
      'onlinetext_editor[format]': '1',
      'onlinetext_editor[itemid]': '550001',
      files_filemanager: '770001',
      submissionstatement: '1',
      submitbutton: '変更を保存する',
    });
    expect(body).not.toHaveProperty('cancel');
  });

  it('keeps the stored text and files when the save sends neither', async () => {
    const post = poster({});
    await run(session(post), 'mod_assign_save_submission', { assignmentid: 99101, plugindata: {}, ...STATEMENT_OK });
    expect(Object.fromEntries(post.posted[0] ?? [])).toMatchObject({
      'onlinetext_editor[text]': '<p>下書きです</p>',
      files_filemanager: '660001',
    });
  });

  it('does not post when the statement is required but not accepted', async () => {
    const post = poster({});
    const res = await run(session(post), 'mod_assign_save_submission', { assignmentid: 99101, plugindata: {} });
    expect(res).toEqual([expect.objectContaining({ warningcode: 'submissionstatementrequired' })]);
    expect(post.posted).toEqual([]);
  });

  it('answers the form errors as warnings when Moodle re-renders the form (200)', async () => {
    const post = poster({ status: 200, html: fixture('assign-edit-error-ja.html'), location: null });
    const res = await run(session(post), 'mod_assign_save_submission', {
      assignmentid: 99101,
      plugindata: {},
      ...STATEMENT_OK,
    });
    expect(res).toEqual([
      { item: 'assignment', itemid: 99101, warningcode: 'couldnotsavesubmission', message: 'この項目は必須です。' },
    ]);
  });

  it('warns without posting when the edit form is not offered', async () => {
    const web = makeFakeWebSession({ pages: {} });
    const res = await run(web, 'mod_assign_save_submission', { assignmentid: 99101, plugindata: {} });
    expect(res).toEqual([expect.objectContaining({ warningcode: 'couldnotsavesubmission' })]);
    expect(web.calls).toEqual([`GET ${edit}`]);
  });
});

describe('mod_assign_submit_for_grading (web)', () => {
  const submit = view(99102, 'submit');
  const session = (post: ReturnType<typeof poster>) =>
    makeFakeWebSession({ pages: { [submit]: fixture('assign-submit-en.html'), '/mod/assign/view.php': post.entry } });

  it('posts the confirm form with the accepted statement', async () => {
    const post = poster({});
    const res = await run(session(post), 'mod_assign_submit_for_grading', { assignmentid: 99102, ...STATEMENT_OK });
    expect(res).toEqual([]);
    expect(Object.fromEntries(post.posted[0] ?? [])).toMatchObject({
      id: '99102',
      action: 'confirmsubmit',
      sesskey: 'fakesesskey01',
      submissionstatement: '1',
      submitbutton: 'Continue',
    });
  });

  it('refuses without the statement and does not post', async () => {
    const post = poster({});
    const params = { assignmentid: 99102, acceptsubmissionstatement: false };
    const res = await run(session(post), 'mod_assign_submit_for_grading', params);
    // the statement may be shown only here (drafts on), so the refusal quotes it for the user
    expect(res).toEqual([
      expect.objectContaining({
        warningcode: 'submissionstatementrequired',
        message: expect.stringContaining('The statement: "This submission is my own work."'),
      }),
    ]);
    expect(post.posted).toEqual([]);
  });
});

describe('action channel guard', () => {
  const COMPLETE = 'core_completion_update_activity_completion_status_manually';

  function setup(prepared: MoodleChannel) {
    const t = makeFakeContext({ scopes: ['moodle:read', 'moodle:write'], responses: { [COMPLETE]: { status: true } } });
    let channel: MoodleChannel = prepared;
    Object.defineProperty(t.api, 'channel', { get: () => channel, configurable: true });
    const prepare = () =>
      savePreview(t.ctx, {
        kind: 'completion',
        title: 'Mark complete',
        details: [],
        warnings: [],
        payload: { cmid: 99101, completed: true, url: `${BASE}${view(99101)}` },
      });
    return { t, prepare, switchTo: (c: MoodleChannel) => (channel = c) };
  }

  it('records the channel at prepare', async () => {
    const { t, prepare } = setup('web');
    const p = await prepare();
    expect(t.state.actions.get(p.actionId)?.payload).toMatchObject({ channel: 'web' });
  });

  it('refuses to run a ws-prepared action on the web channel', async () => {
    const { t, prepare, switchTo } = setup('ws');
    const p = await prepare();
    switchTo('web');
    const res = await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(res).toMatchObject({
      status: 'failed',
      message: 'The Moodle connection changed since this action was prepared. Prepare it again.',
    });
    expect(t.api.count(COMPLETE)).toBe(0);
  });

  it('treats payloads from before the channel was recorded as ws', async () => {
    const { t, prepare, switchTo } = setup('ws');
    const p = await prepare();
    const row = t.state.actions.get(p.actionId);
    if (row) row.payload = { cmid: 99101, completed: true, url: null };
    switchTo('web');
    expect((await confirmAction(t.ctx, p.actionId, 'mcp')).status).toBe('failed');
  });

  it('runs on the same channel; a fresh ws client is settled by one read first', async () => {
    const { t, prepare } = setup('ws');
    const p = await prepare();
    const before = t.api.calls.length;
    const res = await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(res.status).toBe('executed');
    expect(t.api.calls.slice(before).map((c) => c.fn)).toEqual(['core_course_get_recent_courses', COMPLETE]);
  });

  it('runs a web-prepared action on the web channel without the settling read', async () => {
    const { t, prepare } = setup('web');
    const p = await prepare();
    expect((await confirmAction(t.ctx, p.actionId, 'mcp')).status).toBe('executed');
    expect(t.api.calls.map((c) => c.fn)).toEqual([COMPLETE]);
  });
});
