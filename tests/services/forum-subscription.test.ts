import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Forbidden, InvalidInput, MoodleError, NotFound } from '../../src/core/errors';
import { confirmAction, prepareForumSubscription } from '../../src/core/services/actions';
import { listAllCourses } from '../../src/core/services/courses';
import { BASE_URL, createTestContext } from '../helpers/fake-context-be4';

vi.mock('../../src/core/services/courses', () => ({ listAllCourses: vi.fn() }));

const CMID = 7010;

beforeEach(() => {
  vi.mocked(listAllCourses).mockReset();
  vi.mocked(listAllCourses).mockResolvedValue([{ id: 9001, name: 'Corporate Finance Basics' } as never]);
});

function setup(over: { modname?: string; forcesubscribe?: number | null; handlers?: Record<string, unknown> } = {}) {
  const forum: Record<string, unknown> = { id: 3001, course: 9001, cmid: CMID, name: 'Q&amp;A board' };
  if (over.forcesubscribe !== null) forum.forcesubscribe = over.forcesubscribe ?? 0;
  return createTestContext({
    handlers: {
      core_course_get_course_module: {
        cm: { id: CMID, course: 9001, modname: over.modname ?? 'forum', instance: 3001, name: 'Q&amp;A board' },
      },
      mod_forum_get_forums_by_courses: [forum],
      mod_forum_set_forum_subscription: { warnings: [] },
      ...over.handlers,
    },
  });
}

describe('prepareForumSubscription', () => {
  it('previews and executes a subscription', async () => {
    const { ctx, moodle } = setup();
    const preview = await prepareForumSubscription(ctx, { forumCmid: CMID, subscribe: true });
    expect(preview).toMatchObject({ kind: 'forum_subscription', title: "Subscribe to 'Q&A board'" });
    expect(preview.details).toContain('Forum: Q&A board (Corporate Finance Basics)');
    expect(moodle.callsTo('mod_forum_set_forum_subscription')).toHaveLength(0);

    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({
      status: 'executed',
      message: "Subscribed to 'Q&A board'.",
      url: `${BASE_URL}/mod/forum/view.php?id=${CMID}`,
    });
    expect(moodle.callsTo('mod_forum_set_forum_subscription')).toEqual([{ forumid: 3001, targetstate: true }]);
  });

  it('unsubscribes', async () => {
    const { ctx, moodle } = setup();
    const preview = await prepareForumSubscription(ctx, { forumCmid: CMID, subscribe: false });
    expect(preview.title).toBe("Unsubscribe from 'Q&A board'");
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result.message).toBe("Unsubscribed from 'Q&A board'.");
    expect(moodle.callsTo('mod_forum_set_forum_subscription')).toEqual([{ forumid: 3001, targetstate: false }]);
  });

  it('refuses Advanced Forums (hsuforum) with a short reason', async () => {
    const { ctx } = setup({ modname: 'hsuforum' });
    const err = await prepareForumSubscription(ctx, { forumCmid: CMID, subscribe: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidInput);
    expect((err as Error).message).toContain('hsuforum');
  });

  it('refuses activities that are not forums', async () => {
    const { ctx } = setup({ modname: 'assign' });
    const attempt = prepareForumSubscription(ctx, { forumCmid: CMID, subscribe: true });
    await expect(attempt).rejects.toThrow('not a forum');
  });

  it('refuses forums where the subscription is mandatory or disabled', async () => {
    const forced = setup({ forcesubscribe: 1 });
    const mandatory = prepareForumSubscription(forced.ctx, { forumCmid: CMID, subscribe: false });
    await expect(mandatory).rejects.toThrow('mandatory');
    const off = setup({ forcesubscribe: 3 });
    const disabled = prepareForumSubscription(off.ctx, { forumCmid: CMID, subscribe: true });
    await expect(disabled).rejects.toThrow('turned off');
  });

  it('still prepares when the forum listing is unavailable', async () => {
    const { ctx } = setup({
      handlers: {
        mod_forum_get_forums_by_courses: () => {
          throw new MoodleError('nope', 'nopermissions');
        },
      },
    });
    const preview = await prepareForumSubscription(ctx, { forumCmid: CMID, subscribe: true });
    expect(preview.title).toBe("Subscribe to 'Q&A board'");
  });

  it('falls back to ids when no names are known', async () => {
    vi.mocked(listAllCourses).mockRejectedValue(new MoodleError('x', 'x'));
    const { ctx } = setup({ forcesubscribe: null });
    const preview = await prepareForumSubscription(ctx, { forumCmid: CMID, subscribe: true });
    expect(preview.details[0]).toBe('Forum: Q&A board (course 9001)');
  });

  it('reports Moodle warnings as a failed action', async () => {
    const { ctx } = setup({
      handlers: { mod_forum_set_forum_subscription: { warnings: [{ message: 'Not allowed.' }] } },
    });
    const preview = await prepareForumSubscription(ctx, { forumCmid: CMID, subscribe: true });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result.status).toBe('failed');
    expect(result.message).toBe('Moodle did not change the subscription: Not allowed.');
  });

  it('validates the input and the connection', async () => {
    const { ctx } = setup();
    const noId = prepareForumSubscription(ctx, { forumCmid: 0, subscribe: true });
    await expect(noId).rejects.toBeInstanceOf(InvalidInput);
    const notBool = prepareForumSubscription(ctx, { forumCmid: CMID, subscribe: 'yes' as unknown as boolean });
    await expect(notBool).rejects.toBeInstanceOf(InvalidInput);
    const readOnly = createTestContext({ scopes: ['moodle:read'] });
    const denied = prepareForumSubscription(readOnly.ctx, { forumCmid: CMID, subscribe: true });
    await expect(denied).rejects.toBeInstanceOf(Forbidden);
  });

  it('reports an unknown activity', async () => {
    const { ctx } = setup({
      handlers: {
        core_course_get_course_module: () => {
          throw new MoodleError('invalid', 'invalidrecord');
        },
      },
    });
    const attempt = prepareForumSubscription(ctx, { forumCmid: CMID, subscribe: true });
    await expect(attempt).rejects.toBeInstanceOf(NotFound);
  });
});
