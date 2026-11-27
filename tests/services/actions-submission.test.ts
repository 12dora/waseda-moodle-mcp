/** Assignment submission: statement consent, unknown draft stage, keeping a file of unknown size (cr3 P0-1/2, P1-4). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import { confirmAction, prepareSubmission } from '../../src/core/services/actions';
import { MAX_FILE_BYTES } from '../../src/core/services/actions/shared';
import { getActivity } from '../../src/core/services/activity';
import { ASSIGN_CMID, makeAssign, makeSubmission, statusResponse } from '../fixtures/be4/assign';
import { BASE_URL, createTestContext, type TestContext } from '../helpers/fake-context-be4';

vi.mock('../../src/core/services/activity', () => ({ getActivity: vi.fn() }));
vi.mock('../../src/core/services/courses', () => ({ listAllCourses: vi.fn() }));

const getActivityMock = vi.mocked(getActivity);

beforeEach(() => {
  vi.setSystemTime(new Date('2026-10-14T03:00:00Z'));
  getActivityMock.mockReset();
  getActivityMock.mockResolvedValue(makeAssign());
});
afterEach(() => {
  vi.useRealTimers();
});

/** Moodle's status as the writes change it: a save leaves a draft, or submits when `saveSubmits`. */
function moodleWith(saveSubmits: boolean, submitAnswer: unknown = []): TestContext {
  const t = createTestContext();
  t.moodle.handlers.mod_assign_save_submission = [];
  t.moodle.handlers.mod_assign_submit_for_grading = submitAnswer;
  t.moodle.handlers.mod_assign_get_submission_status = () => {
    if (t.moodle.callsTo('mod_assign_submit_for_grading').length) return statusResponse('submitted');
    if (!t.moodle.callsTo('mod_assign_save_submission').length) return statusResponse('new');
    return statusResponse(saveSubmits ? 'submitted' : 'draft');
  };
  return t;
}

const payloadOf = (t: TestContext, id: string) => t.store.actions.get(id)?.payload ?? {};

describe('submission statement consent (P0-1)', () => {
  it('records no acceptance when no statement was shown, even when the caller passed accept_statement', async () => {
    const t = moodleWith(false);
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, onlineText: 'x', acceptStatement: true });
    expect(payloadOf(t, preview.actionId).acceptStatement).toBe(false);
    await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(t.moodle.callsTo('mod_assign_submit_for_grading')).toEqual([
      expect.objectContaining({ acceptsubmissionstatement: false }),
    ]);
  });

  it('a statement Moodle shows only at submit time is refused with its text, asking to re-prepare', async () => {
    const shown = 'This assignment requires accepting the submission statement. The statement: "This is my own work."';
    const t = moodleWith(false, [
      { item: 'assignment', itemid: 5001, warningcode: 'submissionstatementrequired', message: shown },
    ]);
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    const result = await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(result.status).toBe('failed');
    expect(result.message).toContain('Saved as a draft, but Moodle refused to submit it for grading');
    expect(result.message).toContain('This is my own work.');
    expect(result.message).toContain('prepare the submission again with accept_statement=true');
  });

  it('accepts a statement the preview showed once the user accepted it', async () => {
    getActivityMock.mockResolvedValue(makeAssign({ requiresStatement: true, statement: 'This is my own work.' }));
    const t = moodleWith(false);
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, onlineText: 'x', acceptStatement: true });
    expect(payloadOf(t, preview.actionId).acceptStatement).toBe(true);
    await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(t.moodle.callsTo('mod_assign_submit_for_grading')).toEqual([
      expect.objectContaining({ acceptsubmissionstatement: true }),
    ]);
  });
});

describe('unknown draft stage (P0-2)', () => {
  beforeEach(() => {
    const submission = makeSubmission({ canSubmit: false });
    getActivityMock.mockResolvedValue(makeAssign({ draftsEnabled: null, submission }));
  });

  it('never promises a draft: the preview says saving may submit at once', async () => {
    const t = moodleWith(true);
    const keep = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, onlineText: 'x', submitForGrading: false });
    expect(keep.details).toContain('Submit for grading: no, if Moodle keeps drafts (saving may submit it at once)');
    expect(keep.warnings.join('\n')).toContain('saving may submit it at once');
    expect(keep.warnings.join('\n')).not.toContain('stay a draft');

    const submit = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    expect(submit.details).toContain('Submit for grading: yes');
    expect(submit.warnings.join('\n')).not.toContain('may submit');
  });

  it('a save that already submitted is success, not a failed submit for grading', async () => {
    const t = moodleWith(true);
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    const result = await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: 'Submitted. Status: submitted.' });
    expect(t.moodle.callsTo('mod_assign_submit_for_grading')).toHaveLength(0);
  });

  it('submits a save that stayed a draft, only when the user asked for it', async () => {
    const asked = moodleWith(false);
    const p1 = await prepareSubmission(asked.ctx, { cmid: ASSIGN_CMID, onlineText: 'x' });
    expect(await confirmAction(asked.ctx, p1.actionId, 'mcp')).toMatchObject({ status: 'executed' });
    expect(asked.moodle.callsTo('mod_assign_submit_for_grading')).toHaveLength(1);

    const kept = moodleWith(false);
    const p2 = await prepareSubmission(kept.ctx, { cmid: ASSIGN_CMID, onlineText: 'x', submitForGrading: false });
    const r = await confirmAction(kept.ctx, p2.actionId, 'mcp');
    expect(r.message).toBe('Saved. Status: draft (not yet submitted for grading).');
    expect(kept.moodle.callsTo('mod_assign_submit_for_grading')).toHaveLength(0);
  });
});

describe('keeping a current file of unknown size (P1-4)', () => {
  const url = `${BASE_URL}/pluginfile.php/99901/assignsubmission_file/submission_files/11/old.pdf`;

  function withKeptFile(t: TestContext, res: () => Response): void {
    getActivityMock.mockResolvedValue(
      makeAssign({
        submission: makeSubmission({
          status: 'draft',
          files: [{ name: 'old.pdf', size: 0, mime: 'application/pdf', url, modified: null }],
        }),
      }),
    );
    t.moodle.fetchFile = async (fileUrl: string) => {
      t.moodle.fetched.push({ url: fileUrl, method: 'GET' });
      return res();
    };
  }

  const chunked = (parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });

  it('buffers a download without Content-Length and sends its real length', async () => {
    const t = moodleWith(false);
    withKeptFile(t, () => new Response(chunked(['old-', 'bytes'])));
    await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'new.pdf', text: 'n' }] });
    const kept = t.moodle.uploads.find((u) => u.name === 'old.pdf');
    expect(new TextDecoder().decode(kept?.bytes)).toBe('old-bytes');
    expect(kept?.declaredSize).toBe(9);
  });

  it('ignores Content-Length of a compressed download (it is not the decoded length)', async () => {
    const t = moodleWith(false);
    const headers = { 'content-encoding': 'gzip', 'content-length': '4' };
    withKeptFile(t, () => new Response(chunked(['decoded ', 'content']), { headers }));
    await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'new.pdf', text: 'n' }] });
    expect(t.moodle.uploads.find((u) => u.name === 'old.pdf')?.declaredSize).toBe(15);
  });

  it('refuses a kept file over the service limit', async () => {
    const t = moodleWith(false);
    const mb = new Uint8Array(1024 * 1024);
    let sent = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > MAX_FILE_BYTES) c.close();
        else {
          sent += mb.length;
          c.enqueue(mb);
        }
      },
    });
    withKeptFile(t, () => new Response(big));
    const run = prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'new.pdf', text: 'n' }] });
    await expect(run).rejects.toBeInstanceOf(InvalidInput);
    await expect(run).rejects.toThrow('cannot be kept');
  });
});
