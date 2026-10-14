import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Forbidden, InvalidInput, NeedsReconnect, NotFound } from '../../src/core/errors';
import {
  cancelAction,
  confirmAction,
  countCjkChars,
  countWords,
  fileTypeAccepted,
  listActionRecords,
  markdownToSimpleHtml,
  type PrepareSubmissionInput,
  plainTextToHtml,
  prepareCompletion,
  prepareForumPost,
  prepareMessage,
  prepareSubmission,
  sanitizeFileName,
  unverifiableTypes,
} from '../../src/core/services/actions';
import { getActivity } from '../../src/core/services/activity';
import { listAllCourses as listCourses } from '../../src/core/services/courses';
import { ASSIGN_CMID, ASSIGN_INSTANCE, makeAssign, makeSubmission, statusResponse } from '../fixtures/be4/assign';
import { BASE_URL, createTestContext, makeUser, PUBLIC_URL } from '../helpers/fake-context-be4';

vi.mock('../../src/core/services/activity', () => ({ getActivity: vi.fn() }));
vi.mock('../../src/core/services/courses', () => ({ listAllCourses: vi.fn() }));

const getActivityMock = vi.mocked(getActivity);
const listCoursesMock = vi.mocked(listCourses);

const NOW = new Date('2026-10-14T03:00:00Z'); // 12:00 JST

beforeEach(() => {
  vi.setSystemTime(NOW);
  getActivityMock.mockReset();
  getActivityMock.mockResolvedValue(makeAssign());
  listCoursesMock.mockReset();
  listCoursesMock.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('text helpers', () => {
  it('converts markdown to simple, escaped HTML', () => {
    expect(markdownToSimpleHtml('Hello **world** & <b>x</b>\nsecond line\n\nNext para')).toBe(
      '<p>Hello <strong>world</strong> &amp; &lt;b&gt;x&lt;/b&gt;<br>second line</p><p>Next para</p>',
    );
    expect(markdownToSimpleHtml('- a\n- b\n\n1. one\n2. two')).toBe(
      '<ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol>',
    );
    expect(markdownToSimpleHtml('# Title')).toBe('<p><strong>Title</strong></p>');
    expect(markdownToSimpleHtml('see [site](https://example.com/a?b=1&c=2) and `a*b*c`')).toBe(
      '<p>see <a href="https://example.com/a?b=1&amp;c=2">site</a> and <code>a*b*c</code></p>',
    );
  });

  it('does not link unsafe schemes and keeps snake_case intact', () => {
    expect(markdownToSimpleHtml('[x](javascript:alert(1))')).not.toContain('<a ');
    expect(markdownToSimpleHtml('use my_var_name here')).toBe('<p>use my_var_name here</p>');
    expect(markdownToSimpleHtml('an *emphasis* word')).toBe('<p>an <em>emphasis</em> word</p>');
  });

  it('escapes plain chat text and keeps line breaks', () => {
    expect(plainTextToHtml('a < b\nc *d*')).toBe('a &lt; b<br>c *d*');
  });

  it("counts words like Moodle's count_words (whitespace runs, not CJK characters)", () => {
    expect(countWords('Hello brave new world')).toBe(4);
    expect(countWords('これは日本語です')).toBe(1);
    expect(countWords('Valuation は 重要 です.')).toBe(4);
    expect(countWords('one—two – three')).toBe(3);
    expect(countWords('First paragraph\n\nSecond one')).toBe(4);
    expect(countWords('a &amp; b <b>bold</b>text')).toBe(4);
    expect(countCjkChars('これは日本語です abc')).toBe(8);
    expect(countWords('')).toBe(0);
    expect(countWords('see [the docs](https://example.com/very/long/path)')).toBe(3);
  });

  it('sanitizes file names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\temp\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('..')).toBe('');
    expect(sanitizeFileName(`${'a'.repeat(200)}.pdf`)).toHaveLength(120);
    expect(sanitizeFileName(`${'a'.repeat(200)}.pdf`).endsWith('.pdf')).toBe(true);
    expect(sanitizeFileName('a<b>:c.txt')).toBe('a_b__c.txt');
  });

  it('matches accepted file types', () => {
    expect(fileTypeAccepted('a.PDF', ['.pdf', '.docx'])).toBe(true);
    expect(fileTypeAccepted('a.zip', ['.pdf', '.docx'])).toBe(false);
    expect(fileTypeAccepted('a.EPUB', ['document'])).toBe(true);
    expect(fileTypeAccepted('a.zip', ['document'])).toBe(false);
    expect(fileTypeAccepted('a.xlsx', ['spreadsheet'])).toBe(true); // group not mirrored: Moodle decides
    expect(unverifiableTypes(['document', 'image', '.pdf', 'application/pdf', '*', 'Spreadsheet'])).toEqual([
      'image',
      'spreadsheet',
    ]);
    expect(fileTypeAccepted('a.png', ['image/*'])).toBe(true);
    expect(fileTypeAccepted('a.bin', ['mysterygroup'])).toBe(true); // cannot verify unknown groups
    expect(fileTypeAccepted('a.bin', [])).toBe(true);
  });
});

describe('write guards', () => {
  it('rejects read-only connections', async () => {
    const { ctx } = createTestContext({ scopes: ['moodle:read'] });
    await expect(prepareMessage(ctx, { conversationId: 1, text: 'hi' })).rejects.toThrow(
      'This connection is read-only.',
    );
    await expect(prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x' })).rejects.toBeInstanceOf(Forbidden);
  });

  it('rejects when write mode is off', async () => {
    const { ctx } = createTestContext({ user: makeUser({ settings: { writeMode: 'off' } }) });
    await expect(prepareCompletion(ctx, { cmid: 1, completed: true })).rejects.toThrow(
      'Write actions are turned off in settings.',
    );
  });
});

describe('prepareSubmission', () => {
  it('stores a pending action for online text without touching files', async () => {
    const { ctx, store, moodle } = createTestContext();
    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'My memo\n\nSecond paragraph' });

    expect(preview.kind).toBe('assign_submit');
    expect(preview.title).toBe("Submit to 'Report 3' (Strategic Marketing)");
    expect(preview.approval).toBe('chat');
    expect(preview.approveUrl).toBeNull();
    expect(preview.expiresAt).toBe('2026-10-14T12:30:00+09:00');
    expect(preview.details.join('\n')).toContain('Due: 2026-10-20 Tue 23:59');
    expect(preview.details.join('\n')).toContain('Online text (4 words): My memo\n\nSecond paragraph');
    expect(preview.details.join('\n')).toContain('Submit for grading: yes');
    expect(moodle.uploads).toHaveLength(0);

    const row = store.actions.get(preview.actionId)!;
    expect(row).toMatchObject({ status: 'pending', userId: ctx.user.id, kind: 'assign_submit', source: 'Test Client' });
    expect(row.expiresAt - row.createdAt).toBe(30 * 60_000);
    expect(row.payload).toMatchObject({
      assignId: ASSIGN_INSTANCE,
      draftItemId: null,
      onlineText: 'My memo\n\nSecond paragraph',
      submitForGrading: true,
    });
    expect(store.auditLog.map((a) => a.action)).toContain('action:prepare');
  });

  it('uses console approval when write mode is console', async () => {
    const { ctx } = createTestContext({ user: makeUser({ settings: { writeMode: 'console' } }) });
    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    expect(preview.approval).toBe('console');
    expect(preview.approveUrl).toBe(`${PUBLIC_URL}/actions?focus=${preview.actionId}`);
  });

  it('uploads inline files to a fresh draft at prepare time', async () => {
    const { ctx, store, moodle } = createTestContext();
    const preview = await prepareSubmission(ctx, {
      cmid: ASSIGN_CMID,
      files: [
        { name: 'report.pdf', contentBase64: btoa('PDF-DATA') },
        { name: 'notes.docx', text: 'notes' },
      ],
    });
    expect(moodle.uploads.map((u) => u.name)).toEqual(['report.pdf', 'notes.docx']);
    expect(new TextDecoder().decode(moodle.uploads[0]!.bytes)).toBe('PDF-DATA');
    expect(moodle.uploads[0]!.mime).toBe('application/pdf');
    expect(moodle.uploads[0]!.itemId).toBe(moodle.uploads[1]!.itemId);
    expect(store.actions.get(preview.actionId)!.payload.draftItemId).toBe(moodle.uploads[0]!.itemId);
    expect(preview.details).toContain('File: report.pdf (8 B)');
  });

  it('keeps existing files by streaming them into the same draft, except replaced names', async () => {
    const oldUrl = `${BASE_URL}/webservice/pluginfile.php/1/assignsubmission_file/submission_files/9/old.pdf`;
    const dupUrl = `${BASE_URL}/webservice/pluginfile.php/1/assignsubmission_file/submission_files/9/same.pdf`;
    getActivityMock.mockResolvedValue(
      makeAssign({
        submission: makeSubmission({
          status: 'draft',
          files: [
            { name: 'old.pdf', size: 3, mime: 'application/pdf', url: oldUrl, modified: null },
            { name: 'same.pdf', size: 3, mime: 'application/pdf', url: dupUrl, modified: null },
          ],
        }),
      }),
    );
    const { ctx, moodle } = createTestContext();
    moodle.files.set(oldUrl, { body: 'old' });
    moodle.files.set(dupUrl, { body: 'dup' });

    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, files: [{ name: 'same.pdf', text: 'new' }] });
    expect(moodle.uploads.map((u) => u.name)).toEqual(['same.pdf', 'old.pdf']);
    expect(new Set(moodle.uploads.map((u) => u.itemId)).size).toBe(1);
    expect(moodle.fetched.map((f) => f.url)).toEqual([oldUrl]);
    expect(preview.details.join('\n')).toContain('Kept from current submission: old.pdf');
    expect(preview.warnings.join('\n')).toContain("'same.pdf' replaces the current file");
  });

  it('can replace all files (keep_existing_files=false)', async () => {
    const oldUrl = `${BASE_URL}/webservice/pluginfile.php/1/x/old.pdf`;
    getActivityMock.mockResolvedValue(
      makeAssign({
        submission: makeSubmission({ files: [{ name: 'old.pdf', size: 3, mime: null, url: oldUrl, modified: null }] }),
      }),
    );
    const { ctx, moodle } = createTestContext();
    const preview = await prepareSubmission(ctx, {
      cmid: ASSIGN_CMID,
      files: [{ name: 'new.pdf', text: 'n' }],
      keepExistingFiles: false,
    });
    expect(moodle.uploads.map((u) => u.name)).toEqual(['new.pdf']);
    expect(moodle.fetched).toHaveLength(0);
    expect(preview.warnings.join('\n')).toContain('Replaces the 1 file(s)');
  });

  it('uses an upload link draft that belongs to the user and assignment', async () => {
    const { ctx, store, moodle } = createTestContext();
    await store.createUploadDraft({
      id: 'upl_ok',
      userId: ctx.user.id,
      cmid: ASSIGN_CMID,
      draftItemId: 4242,
      files: [{ name: 'big.pdf', size: 1000, mime: 'application/pdf' }],
      totalBytes: 1000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, uploadId: 'upl_ok' });
    expect(store.actions.get(preview.actionId)!.payload.draftItemId).toBe(4242);
    expect(preview.details).toContain('File: big.pdf (1000 B)');
    expect(moodle.uploads).toHaveLength(0);
  });

  it('rejects foreign, wrong-assignment and expired uploads', async () => {
    const { ctx, store } = createTestContext();
    const base = {
      userId: ctx.user.id,
      cmid: ASSIGN_CMID,
      draftItemId: 1,
      files: [],
      totalBytes: 0,
      createdAt: 0,
      expiresAt: Date.now() + 60_000,
    };
    await store.createUploadDraft({ ...base, id: 'upl_other_user', userId: 999 });
    await store.createUploadDraft({ ...base, id: 'upl_other_cm', cmid: 1 });
    await store.createUploadDraft({ ...base, id: 'upl_old', expiresAt: Date.now() - 1 });
    await expect(prepareSubmission(ctx, { cmid: ASSIGN_CMID, uploadId: 'upl_other_user' })).rejects.toBeInstanceOf(
      NotFound,
    );
    await expect(prepareSubmission(ctx, { cmid: ASSIGN_CMID, uploadId: 'upl_other_cm' })).rejects.toBeInstanceOf(
      InvalidInput,
    );
    await expect(prepareSubmission(ctx, { cmid: ASSIGN_CMID, uploadId: 'upl_old' })).rejects.toThrow(
      'already used or has expired',
    );
    await expect(prepareSubmission(ctx, { cmid: ASSIGN_CMID, uploadId: 'upl_missing' })).rejects.toBeInstanceOf(
      NotFound,
    );
  });

  it('validates the assignment rules', async () => {
    const { ctx } = createTestContext();
    const run = (
      over: Parameters<typeof makeAssign>[0],
      input: Omit<PrepareSubmissionInput, 'cmid'> = { onlineText: 'word' },
    ) => {
      getActivityMock.mockResolvedValue(makeAssign(over));
      return prepareSubmission(ctx, { cmid: ASSIGN_CMID, ...input });
    };
    const pdf = { name: 'a.pdf', text: 'x' };
    await expect(run({ wordLimit: 3 }, { onlineText: 'one two three four' })).rejects.toThrow(
      '4 words; the limit is 3',
    );
    await expect(run({ submissionTypes: ['file'] })).rejects.toThrow('does not accept online text');
    await expect(run({ submissionTypes: ['onlinetext'] }, { files: [pdf] })).rejects.toThrow(
      'does not accept file submissions',
    );
    await expect(run({}, { files: [{ name: 'a.zip', text: 'x' }] })).rejects.toThrow('not an accepted type');
    await expect(run({ maxFiles: 1 }, { files: [pdf, { name: 'b.pdf', text: 'y' }] })).rejects.toThrow(
      'Too many files',
    );
    await expect(run({ maxFileBytes: 4 }, { files: [{ name: 'a.pdf', text: 'xxxxx' }] })).rejects.toThrow(
      'the limit is 4 B',
    );
    await expect(run({}, { files: [pdf, { name: 'A.pdf', text: 'y' }] })).rejects.toThrow('Duplicate file name');
    await expect(run({}, { files: [{ name: 'a.pdf' }] })).rejects.toThrow('exactly one of');
    await expect(run({}, { files: [{ name: 'a.pdf', text: 'x', contentBase64: 'eA==' }] })).rejects.toThrow(
      'exactly one of',
    );
    await expect(run({}, { files: [{ name: 'a.pdf', contentBase64: '***' }] })).rejects.toThrow('not valid base64');
    await expect(run({}, {})).rejects.toThrow('Nothing to submit');
  });

  it('enforces window and permission state', async () => {
    const { ctx } = createTestContext();
    const run = (over: Parameters<typeof makeAssign>[0]) => {
      getActivityMock.mockResolvedValue(makeAssign(over));
      return prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    };
    await expect(run({ opensAt: '2026-10-15T09:00:00+09:00' })).rejects.toThrow(
      'Submissions open at 2026-10-15 Thu 09:00',
    );
    await expect(run({ cutoffAt: '2026-10-13T09:00:00+09:00' })).rejects.toThrow('Submissions closed at');
    await expect(run({ submission: makeSubmission({ locked: true }) })).rejects.toThrow('locked');
    await expect(run({ submission: makeSubmission({ canEdit: false }) })).rejects.toThrow('does not allow editing');
    getActivityMock.mockResolvedValue({ type: 'content' } as never);
    await expect(prepareSubmission(ctx, { cmid: 1, onlineText: 'x' })).rejects.toThrow('not an assignment');
  });

  it('warns about late submissions and lets an extension reopen a closed window', async () => {
    const { ctx } = createTestContext();
    getActivityMock.mockResolvedValue(makeAssign({ dueAt: '2026-10-13T23:59:00+09:00' }));
    const late = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    expect(late.warnings.join('\n')).toContain('Late submission');

    getActivityMock.mockResolvedValue(
      makeAssign({
        dueAt: '2026-10-10T23:59:00+09:00',
        cutoffAt: '2026-10-12T23:59:00+09:00',
        submission: makeSubmission({ extensionDue: '2026-10-16T23:59:00+09:00' }),
      }),
    );
    const extended = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    expect(extended.warnings.join('\n')).not.toContain('Late submission');
    expect(extended.details.join('\n')).toContain('(extended)');
  });

  it('requires an explicit statement acceptance', async () => {
    getActivityMock.mockResolvedValue(makeAssign({ requiresStatement: true, statement: 'This is my own work.' }));
    const { ctx, store } = createTestContext();
    await expect(prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x' })).rejects.toThrow(
      'accept_statement=true',
    );
    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x', acceptStatement: true });
    expect(preview.details.join('\n')).toContain('This is my own work.');
    expect(store.actions.get(preview.actionId)!.payload.acceptStatement).toBe(true);
    // a draft-only save of a drafts-enabled assignment does not need the statement yet
    const draftOnly = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x', submitForGrading: false });
    expect(draftOnly.warnings.join('\n')).toContain('stay a draft');
  });

  it('warns when replacing text and when the assignment has no draft stage', async () => {
    getActivityMock.mockResolvedValue(
      makeAssign({ draftsEnabled: false, submission: makeSubmission({ status: 'submitted', onlineText: 'old text' }) }),
    );
    const { ctx } = createTestContext();
    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'new', submitForGrading: false });
    const w = preview.warnings.join('\n');
    expect(w).toContain('replaces the current submission');
    expect(w).toContain('Overwrites the current online text');
    expect(w).toContain('no draft stage');
  });

  it('allows submitting an existing draft for grading without new content', async () => {
    getActivityMock.mockResolvedValue(makeAssign({ submission: makeSubmission({ status: 'draft' }) }));
    const { ctx, store } = createTestContext();
    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID });
    expect(store.actions.get(preview.actionId)!.payload).toMatchObject({
      draftItemId: null,
      onlineText: null,
      submitForGrading: true,
    });
  });

  it('rejects local paths in worker mode', async () => {
    const { ctx } = createTestContext();
    await expect(
      prepareSubmission(ctx, { cmid: ASSIGN_CMID, files: [{ name: 'a.pdf', path: '/tmp/a.pdf' }] }),
    ).rejects.toThrow('only supported in local (stdio) mode');
  });

  it('reads local paths in stdio mode', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wmm-test-'));
    const file = path.join(dir, 'local.pdf');
    await fs.writeFile(file, 'LOCAL-BYTES');
    try {
      const { ctx, moodle } = createTestContext({ mode: 'stdio' });
      await prepareSubmission(ctx, { cmid: ASSIGN_CMID, files: [{ name: 'local.pdf', path: file }] });
      expect(new TextDecoder().decode(moodle.uploads[0]!.bytes)).toBe('LOCAL-BYTES');
      await expect(
        prepareSubmission(ctx, { cmid: ASSIGN_CMID, files: [{ name: 'x.pdf', path: path.join(dir, 'missing.pdf') }] }),
      ).rejects.toBeInstanceOf(NotFound);
      await expect(
        prepareSubmission(ctx, { cmid: ASSIGN_CMID, files: [{ name: 'x.pdf', path: 'relative.pdf' }] }),
      ).rejects.toThrow('absolute');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('confirmAction (assign_submit)', () => {
  async function setup(over: Parameters<typeof createTestContext>[0] = {}) {
    const t = createTestContext(over);
    t.moodle.handlers.mod_assign_save_submission = [];
    t.moodle.handlers.mod_assign_submit_for_grading = [];
    t.moodle.handlers.mod_assign_get_submission_status = statusResponse('submitted');
    return t;
  }

  it('saves, submits for grading, re-reads the status and stores the result', async () => {
    const { ctx, store, moodle } = await setup();
    const preview = await prepareSubmission(ctx, {
      cmid: ASSIGN_CMID,
      onlineText: 'Hello **memo**',
      files: [{ name: 'a.pdf', text: 'x' }],
    });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');

    expect(result).toEqual({
      actionId: preview.actionId,
      status: 'executed',
      message: 'Submitted. Status: submitted.',
      url: `${BASE_URL}/mod/assign/view.php?id=${ASSIGN_CMID}`,
    });
    const [save] = moodle.callsTo('mod_assign_save_submission');
    expect(save).toEqual({
      assignmentid: ASSIGN_INSTANCE,
      plugindata: {
        onlinetext_editor: { text: '<p>Hello <strong>memo</strong></p>', format: 1, itemid: 0 },
        files_filemanager: moodle.uploads[0]!.itemId,
      },
    });
    expect(moodle.callsTo('mod_assign_submit_for_grading')).toEqual([
      { assignmentid: ASSIGN_INSTANCE, acceptsubmissionstatement: true },
    ]);
    expect(moodle.callsTo('mod_assign_get_submission_status')).toEqual([
      { assignid: ASSIGN_INSTANCE, userid: 1001, groupid: 0 },
    ]);
    const row = store.actions.get(preview.actionId)!;
    expect(row).toMatchObject({
      status: 'executed',
      result: `Submitted. Status: submitted.\n${BASE_URL}/mod/assign/view.php?id=${ASSIGN_CMID}`,
      error: null,
    });
    expect(row.executedAt).toBe(NOW.getTime());
    expect(store.auditLog.map((a) => a.action)).toEqual(['action:prepare', 'action:execute']);
    expect(store.auditLog[1]!.actor).toBe('mcp:Test Client');
  });

  it('is idempotent: confirming twice returns the stored result without new Moodle calls', async () => {
    const { ctx, moodle } = await setup();
    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    const first = await confirmAction(ctx, preview.actionId, 'mcp');
    const callsAfterFirst = moodle.calls.length;
    const second = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(second).toEqual(first);
    expect(moodle.calls.length).toBe(callsAfterFirst);
  });

  it('executes once when confirmed concurrently', async () => {
    const { ctx, moodle } = await setup();
    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    const outcomes = await Promise.allSettled([
      confirmAction(ctx, preview.actionId, 'mcp'),
      confirmAction(ctx, preview.actionId, 'mcp'),
    ]);
    expect(moodle.callsTo('mod_assign_save_submission')).toHaveLength(1);
    const done = outcomes.filter((o) => o.status === 'fulfilled');
    expect(done.length).toBeGreaterThanOrEqual(1);
    for (const o of outcomes) {
      if (o.status === 'rejected') expect(String(o.reason)).toContain('already running');
      else expect(o.value.status).toBe('executed');
    }
  });

  it('skips submit_for_grading when the assignment has no draft stage or the user keeps a draft', async () => {
    getActivityMock.mockResolvedValue(makeAssign({ draftsEnabled: false }));
    const a = await setup();
    const p1 = await prepareSubmission(a.ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    await confirmAction(a.ctx, p1.actionId, 'mcp');
    expect(a.moodle.callsTo('mod_assign_submit_for_grading')).toHaveLength(0);

    getActivityMock.mockResolvedValue(makeAssign());
    const b = await setup();
    b.moodle.handlers.mod_assign_get_submission_status = statusResponse('draft');
    const p2 = await prepareSubmission(b.ctx, { cmid: ASSIGN_CMID, onlineText: 'x', submitForGrading: false });
    const r = await confirmAction(b.ctx, p2.actionId, 'mcp');
    expect(b.moodle.callsTo('mod_assign_submit_for_grading')).toHaveLength(0);
    expect(r.message).toBe('Saved. Status: draft (not yet submitted for grading).');
  });

  it('marks the action failed with Moodle warnings and keeps that result on re-confirm', async () => {
    const { ctx, store, moodle } = await setup();
    moodle.handlers.mod_assign_save_submission = [
      { item: 'x', itemid: 0, warningcode: 'couldnotsavesubmission', message: 'Due date reached.' },
    ];
    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result.status).toBe('failed');
    expect(result.message).toBe('Moodle refused the submission: Due date reached.');
    expect(moodle.callsTo('mod_assign_submit_for_grading')).toHaveLength(0);
    expect(store.actions.get(preview.actionId)).toMatchObject({ status: 'failed', error: result.message });
    expect(await confirmAction(ctx, preview.actionId, 'mcp')).toEqual(result);
    expect(moodle.callsTo('mod_assign_save_submission')).toHaveLength(1);
  });

  it('sends only submit_for_grading for an existing draft', async () => {
    getActivityMock.mockResolvedValue(makeAssign({ submission: makeSubmission({ status: 'draft' }) }));
    const { ctx, moodle } = await setup();
    const preview = await prepareSubmission(ctx, { cmid: ASSIGN_CMID });
    await confirmAction(ctx, preview.actionId, 'mcp');
    expect(moodle.callsTo('mod_assign_save_submission')).toHaveLength(0);
    expect(moodle.callsTo('mod_assign_submit_for_grading')).toHaveLength(1);
  });
});

describe('confirmAction guards', () => {
  it('refuses console-approval actions over MCP but runs them from the console', async () => {
    const { ctx, moodle, store } = createTestContext({ user: makeUser({ settings: { writeMode: 'console' } }) });
    moodle.handlers.core_message_send_messages_to_conversation = [{ id: 1 }];
    const preview = await prepareMessage(ctx, { conversationId: 5, text: 'hello' });
    expect(preview.approval).toBe('console');
    await expect(confirmAction(ctx, preview.actionId, 'mcp')).rejects.toThrow(
      `Approve this action in the console: ${PUBLIC_URL}/actions?focus=${preview.actionId}`,
    );
    expect(store.actions.get(preview.actionId)!.status).toBe('pending');
    expect(moodle.callsTo('core_message_send_messages_to_conversation')).toHaveLength(0);

    const result = await confirmAction(ctx, preview.actionId, 'console');
    expect(result.status).toBe('executed');
    expect(store.auditLog.find((a) => a.action === 'action:execute')!.actor).toBe('console');
  });

  it('applies a stricter write mode chosen after the preview', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_send_messages_to_conversation = [{ id: 1 }];
    const preview = await prepareMessage(ctx, { conversationId: 5, text: 'hello' });
    ctx.user.settings.writeMode = 'console';
    await expect(confirmAction(ctx, preview.actionId, 'mcp')).rejects.toBeInstanceOf(Forbidden);
    ctx.user.settings.writeMode = 'off';
    await expect(confirmAction(ctx, preview.actionId, 'console')).rejects.toThrow('turned off');
  });

  it('requires the write scope over MCP', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_send_messages_to_conversation = [{ id: 1 }];
    const preview = await prepareMessage(ctx, { conversationId: 5, text: 'hello' });
    const readOnly = { ...ctx, scopes: ['moodle:read' as const] };
    await expect(confirmAction(readOnly, preview.actionId, 'mcp')).rejects.toThrow('This connection is read-only.');
  });

  it("hides other users' actions and unknown ids", async () => {
    const mine = createTestContext();
    mine.moodle.handlers.core_message_send_messages_to_conversation = [{ id: 1 }];
    const preview = await prepareMessage(mine.ctx, { conversationId: 5, text: 'hello' });
    const other = createTestContext({ store: mine.store, user: makeUser({ id: 2, moodleUserId: 2002 }) });
    await expect(confirmAction(other.ctx, preview.actionId, 'mcp')).rejects.toBeInstanceOf(NotFound);
    await expect(cancelAction(other.ctx, preview.actionId)).rejects.toBeInstanceOf(NotFound);
    await expect(confirmAction(mine.ctx, 'act_missing', 'mcp')).rejects.toBeInstanceOf(NotFound);
  });

  it('expires pending actions after 30 minutes', async () => {
    const { ctx, store, moodle } = createTestContext();
    moodle.handlers.core_message_send_messages_to_conversation = [{ id: 1 }];
    const preview = await prepareMessage(ctx, { conversationId: 5, text: 'hello' });
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    await expect(confirmAction(ctx, preview.actionId, 'mcp')).rejects.toThrow('expired');
    expect(store.actions.get(preview.actionId)!.status).toBe('expired');
    expect(moodle.callsTo('core_message_send_messages_to_conversation')).toHaveLength(0);
  });

  it('keeps the action pending when the Moodle token is gone', async () => {
    const { ctx, store, moodle } = createTestContext();
    moodle.handlers.core_message_send_messages_to_conversation = () => {
      throw new NeedsReconnect();
    };
    const preview = await prepareMessage(ctx, { conversationId: 5, text: 'hello' });
    await expect(confirmAction(ctx, preview.actionId, 'mcp')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(store.actions.get(preview.actionId)!.status).toBe('pending');
  });

  it('refuses cancelled actions', async () => {
    const { ctx } = createTestContext();
    const preview = await prepareMessage(ctx, { conversationId: 5, text: 'hello' });
    await cancelAction(ctx, preview.actionId);
    await expect(confirmAction(ctx, preview.actionId, 'mcp')).rejects.toThrow('cancelled');
  });
});

describe('prepareForumPost / execution', () => {
  it('previews and posts a reply on mod_forum', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.mod_forum_get_discussion_post = {
      post: {
        id: 77,
        subject: 'Question about Q3',
        discussionid: 55,
        author: { fullname: 'Hanako Sato' },
        capabilities: { reply: true },
      },
    };
    moodle.handlers.mod_forum_add_discussion_post = { postid: 88, warnings: [] };
    const preview = await prepareForumPost(ctx, {
      forumType: 'forum',
      replyToPostId: 77,
      message: 'Thanks!\n\nSee **p.3**.',
    });
    expect(preview.kind).toBe('forum_reply');
    expect(preview.title).toBe('Reply to "Question about Q3"');
    expect(preview.details).toContain('Replying to: "Question about Q3" by Hanako Sato');
    expect(preview.details).toContain('Subject: Re: Question about Q3');

    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({
      status: 'executed',
      message: 'Reply posted.',
      url: `${BASE_URL}/mod/forum/discuss.php?d=55#p88`,
    });
    expect(moodle.callsTo('mod_forum_add_discussion_post')).toEqual([
      {
        postid: 77,
        subject: 'Re: Question about Q3',
        message: '<p>Thanks!</p><p>See <strong>p.3</strong>.</p>',
        messageformat: 1,
      },
    ]);
  });

  it('uses the hsuforum functions without messageformat', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.mod_hsuforum_add_discussion_post = { postid: 9 };
    moodle.handlers.mod_hsuforum_add_discussion = { discussionid: 12 };
    const reply = await prepareForumPost(ctx, {
      forumType: 'hsuforum',
      replyToPostId: 3,
      subject: 'Hi',
      message: 'text',
    });
    await confirmAction(ctx, reply.actionId, 'mcp');
    expect(moodle.callsTo('mod_hsuforum_add_discussion_post')).toEqual([
      { postid: 3, subject: 'Hi', message: '<p>text</p>' },
    ]);
    expect(moodle.callsTo('mod_forum_get_discussion_post')).toHaveLength(0);

    const created = await prepareForumPost(ctx, {
      forumType: 'hsuforum',
      forumId: 4,
      subject: 'New topic',
      message: 'body',
    });
    const result = await confirmAction(ctx, created.actionId, 'mcp');
    expect(moodle.callsTo('mod_hsuforum_add_discussion')).toEqual([
      { forumid: 4, subject: 'New topic', message: '<p>body</p>' },
    ]);
    expect(result.url).toBe(`${BASE_URL}/mod/hsuforum/discuss.php?d=12`);
  });

  it('starts a discussion on mod_forum and tolerates a missing name lookup', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_course_get_course_module_by_instance = {
      cm: { id: 10, name: 'Class &amp; Q&amp;A', course: 1 },
    };
    moodle.handlers.mod_forum_add_discussion = { discussionid: 31, warnings: [] };
    const preview = await prepareForumPost(ctx, { forumType: 'forum', forumId: 8, subject: 'Topic', message: 'Body' });
    expect(preview.title).toBe('New discussion in Class & Q&A');
    expect((await confirmAction(ctx, preview.actionId, 'mcp')).url).toBe(`${BASE_URL}/mod/forum/discuss.php?d=31`);

    delete moodle.handlers.core_course_get_course_module_by_instance;
    const fallback = await prepareForumPost(ctx, { forumType: 'forum', forumId: 8, subject: 'Topic', message: 'Body' });
    expect(fallback.title).toBe('New discussion in forum 8');
  });

  it('validates the input and the reply capability', async () => {
    const { ctx, moodle } = createTestContext();
    await expect(prepareForumPost(ctx, { forumType: 'forum', message: 'x' })).rejects.toThrow(
      'either reply_to_post_id',
    );
    await expect(
      prepareForumPost(ctx, { forumType: 'forum', forumId: 1, replyToPostId: 2, message: 'x' }),
    ).rejects.toThrow('either reply_to_post_id');
    await expect(prepareForumPost(ctx, { forumType: 'forum', forumId: 1, message: 'x' })).rejects.toThrow(
      'needs a subject',
    );
    await expect(
      prepareForumPost(ctx, { forumType: 'forum', forumId: 1, subject: 's', message: '  ' }),
    ).rejects.toThrow('empty');
    moodle.handlers.mod_forum_get_discussion_post = {
      post: { id: 1, subject: 's', discussionid: 2, capabilities: { reply: false } },
    };
    await expect(prepareForumPost(ctx, { forumType: 'forum', replyToPostId: 1, message: 'x' })).rejects.toThrow(
      "can't reply",
    );
  });

  it('fails when Moodle returns no post id', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.mod_forum_add_discussion_post = { warnings: [{ message: 'Blocked by throttling.' }] };
    const preview = await prepareForumPost(ctx, { forumType: 'forum', replyToPostId: 1, message: 'x' });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'failed', message: 'Moodle refused the reply: Blocked by throttling.' });
  });
});

describe('prepareMessage / execution', () => {
  it('sends to a conversation as escaped HTML', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_get_conversation = {
      id: 5,
      name: null,
      members: [
        { id: 1001, fullname: 'Taro Yamada' },
        { id: 2002, fullname: 'Hanako Sato' },
      ],
    };
    moodle.handlers.core_message_send_messages_to_conversation = [{ id: 1 }];
    const preview = await prepareMessage(ctx, { conversationId: 5, text: 'a < b\nsecond' });
    expect(preview.title).toBe('Message to Hanako Sato');
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result.message).toBe('Message sent.');
    expect(moodle.callsTo('core_message_send_messages_to_conversation')).toEqual([
      { conversationid: 5, messages: [{ text: 'a &lt; b<br>second', textformat: 1 }] },
    ]);
  });

  it('sends an instant message and reports Moodle-side failures', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_user_get_users_by_field = [{ id: 2002, fullname: 'Hanako Sato' }];
    moodle.handlers.core_message_send_instant_messages = [{ msgid: 10 }];
    const preview = await prepareMessage(ctx, { toUserId: 2002, text: 'hello' });
    expect(preview.title).toBe('Message to Hanako Sato');
    expect((await confirmAction(ctx, preview.actionId, 'mcp')).status).toBe('executed');
    expect(moodle.callsTo('core_message_send_instant_messages')).toEqual([
      { messages: [{ touserid: 2002, text: 'hello', textformat: 1 }] },
    ]);

    moodle.handlers.core_message_send_instant_messages = [{ msgid: -1, errormessage: 'Blocked by the recipient.' }];
    const p2 = await prepareMessage(ctx, { toUserId: 2002, text: 'again' });
    const r2 = await confirmAction(ctx, p2.actionId, 'mcp');
    expect(r2).toMatchObject({
      status: 'failed',
      message: 'Moodle did not send the message: Blocked by the recipient.',
    });
  });

  it('validates recipients and text', async () => {
    const { ctx } = createTestContext();
    await expect(prepareMessage(ctx, { text: 'x' })).rejects.toThrow('either conversation_id or to_user_id');
    await expect(prepareMessage(ctx, { conversationId: 1, toUserId: 2, text: 'x' })).rejects.toThrow(
      'either conversation_id or to_user_id',
    );
    await expect(prepareMessage(ctx, { toUserId: 1001, text: 'x' })).rejects.toThrow('yourself');
    await expect(prepareMessage(ctx, { conversationId: 1, text: ' ' })).rejects.toThrow('empty');
    await expect(prepareMessage(ctx, { conversationId: 1, text: 'x'.repeat(4001) })).rejects.toThrow('too long');
    const preview = await prepareMessage(ctx, { conversationId: 1, text: 'x' }); // lookup handler missing -> fallback name
    expect(preview.title).toBe('Message to conversation 1');
  });
});

describe('prepareCompletion / execution', () => {
  const cm = { cm: { id: 9, course: 301, name: 'Week 3 reading', modname: 'resource' } };
  const statuses = (tracking: number, state: number) => ({ statuses: [{ cmid: 9, tracking, state }], warnings: [] });

  it('marks a manual-completion activity', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_course_get_course_module = cm;
    moodle.handlers.core_completion_get_activities_completion_status = statuses(1, 0);
    moodle.handlers.core_completion_update_activity_completion_status_manually = { status: true, warnings: [] };
    listCoursesMock.mockResolvedValue([{ id: 301, name: 'Strategic Marketing' } as never]);

    const preview = await prepareCompletion(ctx, { cmid: 9, completed: true });
    expect(preview.title).toBe("Mark 'Week 3 reading' complete");
    expect(preview.details).toContain('Activity: Week 3 reading (Strategic Marketing)');
    expect(preview.warnings).toEqual([]);

    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({
      status: 'executed',
      message: 'Marked complete.',
      url: `${BASE_URL}/mod/resource/view.php?id=9`,
    });
    expect(moodle.callsTo('core_completion_update_activity_completion_status_manually')).toEqual([
      { cmid: 9, completed: true },
    ]);
  });

  it('warns when nothing would change', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_course_get_course_module = cm;
    moodle.handlers.core_completion_get_activities_completion_status = statuses(1, 1);
    const preview = await prepareCompletion(ctx, { cmid: 9, completed: true });
    expect(preview.warnings).toEqual(['It is already marked complete.']);
  });

  it('rejects automatic, untracked and unknown activities', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_course_get_course_module = cm;
    moodle.handlers.core_completion_get_activities_completion_status = statuses(2, 0);
    await expect(prepareCompletion(ctx, { cmid: 9, completed: true })).rejects.toThrow('tracked automatically');
    moodle.handlers.core_completion_get_activities_completion_status = statuses(0, 0);
    await expect(prepareCompletion(ctx, { cmid: 9, completed: true })).rejects.toThrow('no completion tracking');
    moodle.handlers.core_completion_get_activities_completion_status = { statuses: [], warnings: [] };
    await expect(prepareCompletion(ctx, { cmid: 9, completed: true })).rejects.toThrow('no completion tracking');
    moodle.handlers.core_course_get_course_module = {};
    await expect(prepareCompletion(ctx, { cmid: 9, completed: true })).rejects.toBeInstanceOf(NotFound);
  });

  it('fails when Moodle answers status=false', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_course_get_course_module = cm;
    moodle.handlers.core_completion_get_activities_completion_status = statuses(1, 0);
    moodle.handlers.core_completion_update_activity_completion_status_manually = {
      status: false,
      warnings: [{ message: 'Not allowed.' }],
    };
    const preview = await prepareCompletion(ctx, { cmid: 9, completed: false });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.message).toContain('Not allowed.');
  });
});

describe('cancelAction / listActionRecords', () => {
  it('cancels a pending action once and is idempotent', async () => {
    const { ctx, store } = createTestContext();
    const preview = await prepareMessage(ctx, { conversationId: 1, text: 'x' });
    expect(await cancelAction(ctx, preview.actionId)).toEqual({
      actionId: preview.actionId,
      status: 'cancelled',
      message: 'Cancelled.',
      url: null,
    });
    expect(await cancelAction(ctx, preview.actionId)).toMatchObject({ status: 'cancelled' });
    expect(store.auditLog.filter((a) => a.action === 'action:cancel')).toHaveLength(1);
  });

  it('refuses to cancel an executed action', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_send_messages_to_conversation = [{ id: 1 }];
    const preview = await prepareMessage(ctx, { conversationId: 1, text: 'x' });
    await confirmAction(ctx, preview.actionId, 'mcp');
    await expect(cancelAction(ctx, preview.actionId)).rejects.toThrow('already executed');
  });

  it('lists records newest first with ISO times and lazily expired status', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_send_messages_to_conversation = [{ id: 1 }];
    const first = await prepareMessage(ctx, { conversationId: 1, text: 'first' });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const second = await prepareMessage(ctx, { conversationId: 1, text: 'second' });
    await confirmAction(ctx, second.actionId, 'mcp');
    vi.setSystemTime(new Date(NOW.getTime() + 40 * 60_000));

    const all = await listActionRecords(ctx, {});
    expect(all.map((r) => r.id)).toEqual([second.actionId, first.actionId]);
    expect(all[0]).toMatchObject({ status: 'executed', source: 'Test Client', result: 'Message sent.', error: null });
    expect(all[0]!.executedAt).toBe('2026-10-14T12:01:00+09:00');
    expect(all[1]).toMatchObject({
      status: 'expired',
      executedAt: null,
      createdAt: '2026-10-14T12:00:00+09:00',
      expiresAt: '2026-10-14T12:30:00+09:00',
    });
    expect(await listActionRecords(ctx, { status: 'pending' })).toEqual([]);
  });
});
