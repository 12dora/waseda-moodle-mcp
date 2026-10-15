import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, NeedsReconnect } from '../../src/core/errors';
import {
  cancelAction,
  confirmAction,
  prepareForumPost,
  prepareMessage,
  prepareSubmission,
} from '../../src/core/services/actions';
import { getActivity } from '../../src/core/services/activity';
import { createUploadLink, streamUpload } from '../../src/core/services/files';
import { ASSIGN_CMID, ASSIGN_INSTANCE, makeAssign, makeSubmission, statusWithText } from '../fixtures/be4/assign';
import { BASE_URL, createTestContext, makeUser, type TestContext } from '../helpers/fake-context-be4';

vi.mock('../../src/core/services/activity', () => ({ getActivity: vi.fn() }));
vi.mock('../../src/core/services/courses', () => ({ listCourses: vi.fn() }));

const getActivityMock = vi.mocked(getActivity);
const NOW = new Date('2026-10-14T03:00:00Z'); // 12:00 JST

beforeEach(() => {
  vi.setSystemTime(NOW);
  getActivityMock.mockReset();
  getActivityMock.mockResolvedValue(makeAssign());
});
afterEach(() => {
  vi.useRealTimers();
});

function submissionContext(status = statusWithText('draft', '<p>Existing <b>text</b></p>', 1)) {
  const t = createTestContext();
  t.moodle.handlers.mod_assign_get_submission_status = status;
  t.moodle.handlers.mod_assign_save_submission = [];
  t.moodle.handlers.mod_assign_submit_for_grading = [];
  return t;
}

describe('files-only submissions keep the online text (P0)', () => {
  it('resends the current raw text and format with the save', async () => {
    const t = submissionContext(statusWithText('draft', '<p>Existing <b>text</b></p>', 1));
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'a.pdf', text: 'x' }] });
    await confirmAction(t.ctx, preview.actionId, 'mcp');

    const [save] = t.moodle.callsTo('mod_assign_save_submission');
    expect(save).toMatchObject({
      assignmentid: ASSIGN_INSTANCE,
      plugindata: {
        onlinetext_editor: { text: '<p>Existing <b>text</b></p>', format: 1, itemid: 0 },
        files_filemanager: t.moodle.uploads[0]!.itemId,
      },
    });
    // the pre-save read must come before the save, and the post-save status read must not reuse its memo
    const reads = t.moodle.calls.filter((c) => c.fn === 'mod_assign_get_submission_status');
    expect(reads.map((c) => c.params.groupid)).toEqual([undefined, 0]);
    const order = t.moodle.calls.map((c) => c.fn);
    expect(order.indexOf('mod_assign_get_submission_status')).toBeLessThan(order.indexOf('mod_assign_save_submission'));
  });

  it('keeps a non-HTML format and sends an empty editor when there is no text yet', async () => {
    const t = submissionContext(statusWithText('draft', '*md*', 4));
    const p1 = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'a.pdf', text: 'x' }] });
    await confirmAction(t.ctx, p1.actionId, 'mcp');
    expect(t.moodle.callsTo('mod_assign_save_submission')[0]).toMatchObject({
      plugindata: { onlinetext_editor: { text: '*md*', format: 4, itemid: 0 } },
    });

    const fresh = submissionContext({ lastattempt: { submission: { status: 'new', plugins: [] } } } as never);
    const p2 = await prepareSubmission(fresh.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'a.pdf', text: 'x' }] });
    await confirmAction(fresh.ctx, p2.actionId, 'mcp');
    expect(fresh.moodle.callsTo('mod_assign_save_submission')[0]).toMatchObject({
      plugindata: { onlinetext_editor: { text: '', format: 1, itemid: 0 } },
    });
  });

  it('does not send online text for assignments without the plugin', async () => {
    getActivityMock.mockResolvedValue(makeAssign({ submissionTypes: ['file'] }));
    const t = submissionContext();
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'a.pdf', text: 'x' }] });
    await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(t.moodle.callsTo('mod_assign_save_submission')[0]!.plugindata).not.toHaveProperty('onlinetext_editor');
  });

  it('writes nothing when the current text cannot be read', async () => {
    const t = submissionContext();
    t.moodle.handlers.mod_assign_get_submission_status = () => {
      throw new Error('boom');
    };
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'a.pdf', text: 'x' }] });
    const result = await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(result.status).toBe('failed');
    expect(t.moodle.callsTo('mod_assign_save_submission')).toHaveLength(0);
  });

  it('refuses to clear the files when that would leave the submission empty', async () => {
    const url = `${BASE_URL}/webservice/pluginfile.php/1/x/old.pdf`;
    getActivityMock.mockResolvedValue(
      makeAssign({
        submission: makeSubmission({ files: [{ name: 'old.pdf', size: 3, mime: null, url, modified: null }] }),
      }),
    );
    const t = submissionContext();
    await expect(prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, keepExistingFiles: false })).rejects.toThrow(
      'leave the submission empty',
    );
    // with existing online text the same request is fine, and the executor refuses if the text vanished meanwhile
    getActivityMock.mockResolvedValue(
      makeAssign({
        submission: makeSubmission({
          onlineText: 'kept',
          files: [{ name: 'old.pdf', size: 3, mime: null, url, modified: null }],
        }),
      }),
    );
    t.moodle.handlers.mod_assign_get_submission_status = statusWithText('draft', '');
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, keepExistingFiles: false });
    const result = await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.message).toContain('leave the submission empty');
    expect(t.moodle.callsTo('mod_assign_save_submission')).toHaveLength(0);
  });

  it('ignores failures of the status re-read after a successful write', async () => {
    const t = submissionContext();
    let reads = 0;
    t.moodle.handlers.mod_assign_get_submission_status = () => {
      if (++reads > 1) throw new NeedsReconnect();
      return statusWithText('draft', '<p>t</p>');
    };
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'a.pdf', text: 'x' }] });
    const result = await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: 'Saved.' });
  });
});

describe('claiming (P1-2, P3-9)', () => {
  async function pending(t: TestContext) {
    t.moodle.handlers.core_message_send_messages_to_conversation = [{ id: 1 }];
    return prepareMessage(t.ctx, { conversationId: 5, text: 'hello' });
  }

  it('moves the action through executing and stores the result', async () => {
    const t = createTestContext();
    const preview = await pending(t);
    const claim = vi.spyOn(t.store, 'claimAction');
    const result = await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(claim).toHaveBeenCalledWith(preview.actionId, t.ctx.user.id, NOW.getTime());
    expect(result.status).toBe('executed');
    expect(t.store.actions.get(preview.actionId)!.status).toBe('executed');
  });

  it('answers "already running" to a caller that lost the claim, and to later callers', async () => {
    const t = createTestContext();
    const preview = await pending(t);
    expect(await t.store.claimAction(preview.actionId, t.ctx.user.id, NOW.getTime())).toBe(true); // another request
    await expect(confirmAction(t.ctx, preview.actionId, 'mcp')).rejects.toThrow('This action is already running.');
    await expect(confirmAction(t.ctx, preview.actionId, 'console')).rejects.toThrow('already running');
    await expect(cancelAction(t.ctx, preview.actionId)).rejects.toThrow('already running');
    expect(t.moodle.callsTo('core_message_send_messages_to_conversation')).toHaveLength(0);
  });

  it('returns the stored result when the claim was lost to a request that already finished', async () => {
    const t = createTestContext();
    const preview = await pending(t);
    const real = t.store.claimAction.bind(t.store);
    let raced = false;
    t.store.claimAction = async (...args) => {
      if (!raced) {
        raced = true;
        await confirmAction(t.ctx, preview.actionId, 'mcp'); // the winner runs to completion first
      }
      return real(...args);
    };
    expect(await confirmAction(t.ctx, preview.actionId, 'mcp')).toMatchObject({ status: 'executed' });
    expect(t.moodle.callsTo('core_message_send_messages_to_conversation')).toHaveLength(1);
  });

  it('fails an executing action whose worker died long ago', async () => {
    const t = createTestContext();
    const preview = await pending(t);
    await t.store.claimAction(preview.actionId, t.ctx.user.id, NOW.getTime());
    vi.setSystemTime(new Date(NOW.getTime() + 60 * 60_000));
    const result = await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.message).toContain('interrupted');
  });

  it('never returns the row to pending when recording the result fails', async () => {
    const t = createTestContext();
    const preview = await pending(t);
    const real = t.store.updateAction.bind(t.store);
    let failures = 1;
    t.store.updateAction = async (id, patch) => {
      if (patch.status === 'executed' && failures-- > 0) throw new Error('db down');
      return real(id, patch);
    };
    const result = await confirmAction(t.ctx, preview.actionId, 'mcp');
    expect(result.status).toBe('executed');
    expect(t.store.actions.get(preview.actionId)!.status).toBe('executed'); // retried once

    const again = await pending(t);
    t.store.updateAction = async () => {
      throw new Error('db down');
    };
    expect((await confirmAction(t.ctx, again.actionId, 'mcp')).status).toBe('executed');
    expect(t.store.actions.get(again.actionId)!.status).toBe('executing'); // the write happened: never back to pending
  });

  it('a refused MCP confirm does not claim: the console can still approve', async () => {
    const t = createTestContext({ user: makeUser({ settings: { writeMode: 'console' } }) });
    const preview = await pending(t);
    await expect(confirmAction(t.ctx, preview.actionId, 'mcp')).rejects.toThrow('Approve this action in the console');
    expect(t.store.actions.get(preview.actionId)!.status).toBe('pending');
    expect((await confirmAction(t.ctx, preview.actionId, 'console')).status).toBe('executed');
  });

  it('replays the outcome URL for forum posts', async () => {
    const t = createTestContext();
    t.moodle.handlers.mod_forum_get_discussion_post = { post: { id: 7, subject: 'Q', discussionid: 55 } };
    t.moodle.handlers.mod_forum_add_discussion_post = { postid: 88 };
    const preview = await prepareForumPost(t.ctx, { forumType: 'forum', replyToPostId: 7, message: 'hi' });
    const first = await confirmAction(t.ctx, preview.actionId, 'mcp');
    const url = `${BASE_URL}/mod/forum/discuss.php?d=55#p88`;
    expect(first.url).toBe(url);
    expect(await confirmAction(t.ctx, preview.actionId, 'mcp')).toEqual(first);
    expect(t.store.actions.get(preview.actionId)!.result).toBe(`Reply posted.\n${url}`);
  });
});

describe('upload links are frozen by prepare (P1-3)', () => {
  it('consumes the link: a second prepare and later uploads are refused', async () => {
    const t = createTestContext();
    const link = await createUploadLink(t.ctx, ASSIGN_CMID);
    const ticket = link.uploadUrl.split('/').pop()!;
    const env = { store: t.store, signer: t.signer, makeMoodle: async () => t.moodle };
    const put = (name: string) =>
      new Request(`https://svc.example.com/u/x?name=${name}`, {
        method: 'PUT',
        body: new TextEncoder().encode('pdf') as unknown as BodyInit,
        headers: { 'content-length': '3' },
      });
    expect((await streamUpload(env, ticket, put('a.pdf'))).status).toBe(200);

    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, uploadId: link.uploadId });
    expect(t.store.actions.get(preview.actionId)!.payload.draftItemId).toBe(link.draftItemId);
    expect(t.store.uploads.get(link.uploadId)!.expiresAt).toBeLessThanOrEqual(NOW.getTime());

    expect((await streamUpload(env, ticket, put('b.pdf'))).status).toBe(404);
    const err = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, uploadId: link.uploadId }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInput);
    expect(err.message).toBe('This upload link was already used or has expired; create a new one.');
  });

  it('does not burn the link when the request is rejected by validation', async () => {
    const t = createTestContext();
    const link = await createUploadLink(t.ctx, ASSIGN_CMID);
    await t.store.appendUploadedFile(link.uploadId, { name: 'a.zip', size: 3, mime: null });
    await expect(prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, uploadId: link.uploadId })).rejects.toThrow(
      'accepted type',
    );
    expect(t.store.uploads.get(link.uploadId)!.expiresAt).toBeGreaterThan(NOW.getTime());
  });
});

describe('inline files (P2-5)', () => {
  const big = (n: number) => btoa('a'.repeat(n));

  it('limits inline files to 1 MiB in the Worker but not locally', async () => {
    const t = createTestContext();
    await expect(
      prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'a.pdf', contentBase64: big(1024 * 1024 + 10) }] }),
    ).rejects.toThrow('create_upload_link');
    await prepareSubmission(t.ctx, {
      cmid: ASSIGN_CMID,
      files: [{ name: 'a.pdf', contentBase64: big(1024 * 1024 - 10) }],
    });

    const local = createTestContext({ mode: 'stdio' });
    await prepareSubmission(local.ctx, {
      cmid: ASSIGN_CMID,
      files: [{ name: 'a.pdf', contentBase64: big(2 * 1024 * 1024) }],
    });
    expect(local.moodle.uploads[0]!.bytes).toHaveLength(2 * 1024 * 1024);
  });

  it('decodes with and without the native Uint8Array.fromBase64', async () => {
    const holder = Uint8Array as unknown as { fromBase64?: unknown };
    const original = holder.fromBase64;
    const text = 'héllo '.repeat(20_000); // > one decoder chunk
    try {
      for (const native of [original, undefined]) {
        holder.fromBase64 = native;
        const t = createTestContext({ mode: 'stdio' });
        const bytes = new TextEncoder().encode(text);
        const b64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
        await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'a.pdf', contentBase64: b64 }] });
        expect(new TextDecoder().decode(t.moodle.uploads[0]!.bytes)).toBe(text);
      }
    } finally {
      holder.fromBase64 = original;
    }
  });
});

describe('previews and audit', () => {
  it('warns about accepted-type groups it cannot check', async () => {
    getActivityMock.mockResolvedValue(makeAssign({ acceptedTypes: ['image', '.pdf'] }));
    const t = createTestContext();
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, files: [{ name: 'a.pdf', text: 'x' }] });
    expect(preview.warnings.join('\n')).toContain('File types (image) could not be checked here');
  });

  it('shows the CJK count and the full text up to 4000 chars', async () => {
    const t = createTestContext();
    const text = `日本語${'a '.repeat(10)}`;
    const preview = await prepareSubmission(t.ctx, { cmid: ASSIGN_CMID, onlineText: text });
    expect(preview.details.join('\n')).toContain(`Online text (10 words, 3 CJK characters): ${text}`);

    const message = 'm'.repeat(4500);
    t.moodle.handlers.core_course_get_course_module_by_instance = { cm: { name: 'F' } };
    const post = await prepareForumPost(t.ctx, { forumType: 'forum', forumId: 3, subject: 's', message });
    const line = post.details.find((d) => d.startsWith('Message: '))!;
    expect(line).toBe(`Message: ${'m'.repeat(4000)}… (500 more chars)`);
    const dm = await prepareMessage(t.ctx, { conversationId: 1, text: 'n'.repeat(4000) });
    expect(dm.details[1]).toBe(`Message: ${'n'.repeat(4000)}`);
  });

  it('looks hsuforum parents up when the discussion is known', async () => {
    const t = createTestContext();
    t.moodle.handlers.mod_hsuforum_get_forum_discussion_posts = {
      posts: [{ id: 9, subject: 'Ask &amp; answer', author: { fullname: 'Hanako Sato' } }],
    };
    const preview = await prepareForumPost(t.ctx, {
      forumType: 'hsuforum',
      replyToPostId: 9,
      discussionId: 4,
      message: 'hi',
    });
    expect(preview.details).toContain('Replying to: "Ask & answer" by Hanako Sato');
    expect(preview.details).toContain('Subject: Re: Ask & answer');
    expect(t.store.actions.get(preview.actionId)!.payload.discussionId).toBe(4);
  });

  it('refuses an hsuforum reply whose post is not in the given discussion', async () => {
    const t = createTestContext();
    t.moodle.handlers.mod_hsuforum_get_forum_discussion_posts = { posts: [{ id: 9, subject: 'Ask' }] };
    const input = { forumType: 'hsuforum' as const, replyToPostId: 10, discussionId: 4, message: 'hi' };
    const err = await prepareForumPost(t.ctx, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidInput);
    expect((err as Error).message).toBe('post 10 is not in discussion 4; open it with get_discussion');
    // a discussion that cannot be read is not proof of anything: the preview falls back to the bare post id
    const down = createTestContext();
    const preview = await prepareForumPost(down.ctx, input);
    expect(preview.details).toContain('Replying to post 10');
  });

  it('adds a warning when console approval is unavailable locally', async () => {
    const t = createTestContext({ mode: 'stdio', user: makeUser({ settings: { writeMode: 'console' } }) });
    const preview = await prepareMessage(t.ctx, { conversationId: 1, text: 'x' });
    expect(preview.approval).toBe('chat');
    expect(preview.approveUrl).toBeNull();
    expect(preview.warnings).toContain('Console approval is unavailable locally; confirming in chat.');
    const hosted = createTestContext({ user: makeUser({ settings: { writeMode: 'console' } }) });
    expect((await prepareMessage(hosted.ctx, { conversationId: 1, text: 'x' })).warnings).not.toContain(
      'Console approval is unavailable locally; confirming in chat.',
    );
  });

  it('derives the audit actor from how the action arrived, not from the source label', async () => {
    const t = createTestContext({ source: 'Console' });
    t.moodle.handlers.core_message_send_messages_to_conversation = [{ id: 1 }];
    const a = await prepareMessage(t.ctx, { conversationId: 5, text: 'a' });
    await confirmAction(t.ctx, a.actionId, 'mcp');
    const b = await prepareMessage(t.ctx, { conversationId: 5, text: 'b' });
    await confirmAction(t.ctx, b.actionId, 'console');
    const c = await prepareMessage(t.ctx, { conversationId: 5, text: 'c' });
    await cancelAction(t.ctx, c.actionId, 'console');
    const d = await prepareMessage(t.ctx, { conversationId: 5, text: 'd' });
    await cancelAction(t.ctx, d.actionId);
    const actors = t.store.auditLog.filter((r) => r.action !== 'action:prepare').map((r) => [r.action, r.actor]);
    expect(actors).toEqual([
      ['action:execute', 'mcp:Console'],
      ['action:execute', 'console'],
      ['action:cancel', 'console'],
      ['action:cancel', 'mcp:Console'],
    ]);
  });
});
