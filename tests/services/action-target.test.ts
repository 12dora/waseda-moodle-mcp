import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, MoodleUnavailable } from '../../src/core/errors';
import { cancelAction, confirmAction, listActionRecords, prepareMessage } from '../../src/core/services/actions';
import { actionTarget, SUPERSEDED_RESULT, UNCERTAIN_MARK } from '../../src/core/services/actions/target';
import { createTestContext, type TestContext } from '../helpers/fake-context-be4';

const NOW = new Date('2026-10-14T03:00:00Z'); // 12:00 JST
const SEND = 'core_message_send_messages_to_conversation';
const SUPERSEDED = 'Another action for the same target already ran. Prepare it again if you still need it.';

beforeEach(() => {
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (ms: number) => vi.setSystemTime(new Date(NOW.getTime() + ms));

function setup(opts: Parameters<typeof createTestContext>[0] = {}): TestContext {
  const t = createTestContext(opts);
  t.moodle.handlers[SEND] = [{ id: 1 }];
  return t;
}

/** Two versions of one message, prepared 10 s apart (the 2026-11-18 incident shape). */
async function rivals(t: TestContext) {
  const a = await prepareMessage(t.ctx, { conversationId: 99, text: 'draft' });
  at(10_000);
  const b = await prepareMessage(t.ctx, { conversationId: 99, text: 'revised' });
  at(20_000);
  return { a, b };
}

describe('actionTarget', () => {
  it('keys every kind by what it writes to', () => {
    expect(actionTarget('forum_discussion', { forumType: 'forum', forumId: 99, postId: null })).toBe(
      'forum_discussion:forum:99',
    );
    expect(actionTarget('forum_reply', { forumType: 'hsuforum', postId: 100, forumId: null })).toBe(
      'forum_reply:hsuforum:100',
    );
    expect(actionTarget('forum_post_edit', { postId: 101 })).toBe('forum_post_edit:101');
    expect(actionTarget('forum_post_delete', { postId: 101, forumId: 99 })).toBe('forum_post_delete:101');
    expect(actionTarget('assign_submit', { cmid: 99, assignId: 7 })).toBe('assign_submit:99');
    expect(actionTarget('message', { conversationId: 100, toUserId: null })).toBe('message:c100');
    expect(actionTarget('message', { conversationId: null, toUserId: 101 })).toBe('message:u101');
    expect(actionTarget('completion', { cmid: 99, completed: true })).toBe('completion:99');
    expect(actionTarget('forum_subscription', { forumId: 99, subscribe: true })).toBe('forum_subscription:99');
    expect(actionTarget('questionnaire_submit', { cmid: 99, questionnaireId: 7 })).toBe('questionnaire_submit:99');
  });

  it('gives no target to mark_read and to missing or invalid ids', () => {
    expect(actionTarget('mark_read', { conversationId: 99, notificationIds: [], allNotifications: false })).toBeNull();
    expect(actionTarget('forum_discussion', { forumType: 'forum', forumId: null })).toBeNull();
    expect(actionTarget('forum_reply', { forumType: 'other', postId: 100 })).toBeNull();
    expect(actionTarget('forum_post_edit', { postId: '101' })).toBeNull();
    expect(actionTarget('completion', { cmid: 0 })).toBeNull();
    expect(actionTarget('assign_submit', { cmid: 1.5 })).toBeNull();
    expect(actionTarget('message', { conversationId: -1, toUserId: 101 })).toBeNull();
    expect(actionTarget('message', { conversationId: null, toUserId: null })).toBeNull();
    expect(actionTarget('questionnaire_submit', {})).toBeNull();
  });
});

describe('rival actions of one target', () => {
  it('stores the target and warns at prepare time about a pending rival (newest id, one line)', async () => {
    const t = setup();
    const { a, b } = await rivals(t);
    expect(t.store.actions.get(a.actionId)!.target).toBe('message:c99');
    expect(a.warnings.some((w) => w.includes('same target'))).toBe(false);
    const warning = (id: string) => `Another pending action has the same target (${id}); only one of them can run.`;
    expect(b.warnings).toContain(warning(a.actionId));
    const c = await prepareMessage(t.ctx, { conversationId: 99, text: 'third' });
    expect(c.warnings.filter((w) => w.includes('same target'))).toEqual([warning(b.actionId)]);
    const other = await prepareMessage(t.ctx, { conversationId: 100, text: 'elsewhere' });
    expect(other.warnings.some((w) => w.includes('same target'))).toBe(false);
  });

  it('does not warn about an expired rival', async () => {
    const t = setup();
    await prepareMessage(t.ctx, { conversationId: 99, text: 'old' });
    at(31 * 60_000);
    const fresh = await prepareMessage(t.ctx, { conversationId: 99, text: 'new' });
    expect(fresh.warnings.some((w) => w.includes('same target'))).toBe(false);
  });

  it('supersedes the stale version once the revised one ran, and refuses to run it later', async () => {
    const t = setup();
    const { a, b } = await rivals(t);
    expect(await confirmAction(t.ctx, b.actionId, 'mcp')).toMatchObject({ status: 'executed' });
    expect(t.store.actions.get(a.actionId)).toMatchObject({ status: 'superseded', result: SUPERSEDED_RESULT });
    const supersede = t.store.auditLog.filter((r) => r.action === 'action:supersede');
    expect(supersede).toHaveLength(1);
    expect(supersede[0]!.detail).toMatchObject({ ids: [a.actionId], after: b.actionId });

    const err = await confirmAction(t.ctx, a.actionId, 'console').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidInput);
    expect((err as Error).message).toBe(SUPERSEDED);
    await expect(confirmAction(t.ctx, a.actionId, 'mcp')).rejects.toThrow(SUPERSEDED);
    expect(await cancelAction(t.ctx, a.actionId, 'console')).toEqual({
      actionId: a.actionId,
      status: 'superseded',
      message: 'Already superseded.',
      url: null,
    });
    expect(t.moodle.callsTo(SEND)).toHaveLength(1);
    expect((await listActionRecords(t.ctx, { status: 'superseded' })).map((r) => r.id)).toEqual([a.actionId]);
  });

  it('blocks the stale version at claim time even when the sweep after the run was lost', async () => {
    const t = setup();
    const { a, b } = await rivals(t);
    const real = t.store.supersedeActions.bind(t.store);
    t.store.supersedeActions = async () => {
      throw new Error('db down');
    };
    expect(await confirmAction(t.ctx, b.actionId, 'mcp')).toMatchObject({ status: 'executed' });
    expect(t.store.actions.get(a.actionId)!.status).toBe('pending');
    t.store.supersedeActions = real;

    await expect(confirmAction(t.ctx, a.actionId, 'console')).rejects.toThrow(SUPERSEDED);
    expect(t.store.actions.get(a.actionId)).toMatchObject({ status: 'superseded', result: SUPERSEDED_RESULT });
    expect(t.store.auditLog.filter((r) => r.action === 'action:supersede')).toHaveLength(1);
    expect(t.moodle.callsTo(SEND)).toHaveLength(1);
  });

  it('answers "running" while a rival is executing, and leaves the action pending', async () => {
    const t = setup();
    const { a, b } = await rivals(t);
    expect(await t.store.claimAction(b.actionId, t.ctx.user.id, Date.now())).toBe(true); // another request
    await expect(confirmAction(t.ctx, a.actionId, 'console')).rejects.toThrow(
      'Another action for the same target is running.',
    );
    expect(t.store.actions.get(a.actionId)!.status).toBe('pending');
    expect(t.moodle.callsTo(SEND)).toHaveLength(0);
  });

  it('runs exactly one of two rivals confirmed at once (chat and console)', async () => {
    const t = setup();
    const { a, b } = await rivals(t);
    const results = await Promise.allSettled([
      confirmAction(t.ctx, b.actionId, 'mcp'),
      confirmAction(t.ctx, a.actionId, 'console'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(InvalidInput);
    expect((refused.reason as Error).message).toMatch(/same target/);
    expect(t.moodle.callsTo(SEND)).toHaveLength(1);
  });

  it('supersedes nothing when the run failed: the other version can still run', async () => {
    const t = setup();
    const { a, b } = await rivals(t);
    t.moodle.handlers[SEND] = () => {
      throw new MoodleError('Conversation not found.');
    };
    expect(await confirmAction(t.ctx, b.actionId, 'mcp')).toMatchObject({ status: 'failed' });
    expect(t.store.actions.get(a.actionId)!.status).toBe('pending');
    t.moodle.handlers[SEND] = [{ id: 1 }];
    expect(await confirmAction(t.ctx, a.actionId, 'mcp')).toMatchObject({ status: 'executed' });
  });

  it('treats a run that may have gone through as a run: the other version is superseded', async () => {
    const t = setup();
    const { a, b } = await rivals(t);
    t.moodle.handlers[SEND] = () => {
      throw new MoodleUnavailable();
    };
    const r = await confirmAction(t.ctx, b.actionId, 'mcp');
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.message).toContain(UNCERTAIN_MARK);
    expect(t.store.actions.get(a.actionId)).toMatchObject({ status: 'superseded', result: SUPERSEDED_RESULT });
    t.moodle.handlers[SEND] = [{ id: 1 }];
    await expect(confirmAction(t.ctx, a.actionId, 'console')).rejects.toThrow(SUPERSEDED);
    expect(t.moodle.callsTo(SEND)).toHaveLength(1);
  });

  it('allows a write prepared after the earlier one ran', async () => {
    const t = setup();
    const first = await prepareMessage(t.ctx, { conversationId: 99, text: 'one' });
    await confirmAction(t.ctx, first.actionId, 'mcp');
    at(1000);
    const next = await prepareMessage(t.ctx, { conversationId: 99, text: 'two' });
    expect(next.warnings.some((w) => w.includes('same target'))).toBe(false);
    expect(await confirmAction(t.ctx, next.actionId, 'mcp')).toMatchObject({ status: 'executed' });
    expect(t.moodle.callsTo(SEND)).toHaveLength(2);
  });
});
