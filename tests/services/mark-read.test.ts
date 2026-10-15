import { describe, expect, it } from 'vitest';
import { Forbidden, InvalidInput, MoodleError, NotFound } from '../../src/core/errors';
import { confirmAction, prepareMarkRead } from '../../src/core/services/actions';
import { popupFeed } from '../fixtures/r8/messaging';
import { createTestContext, makeUser } from '../helpers/fake-context-be4';

describe('prepareMarkRead', () => {
  it('previews notifications by subject and notes ids missing from the recent feed', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.message_popup_get_popup_notifications = popupFeed;
    const p = await prepareMarkRead(ctx, { notificationIds: [501, 999, 501] });
    expect(p.kind).toBe('mark_read');
    expect(p.title).toBe('Mark 2 notifications as read');
    expect(p.details).toEqual(['Notifications: 2', 'Grade & feedback posted', '1 older notification (ids 999)']);
    expect(p.warnings).toEqual(['1 id was not found in your latest 100 notifications.']);
  });

  it('previews all notifications with the unread count', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_get_unread_notification_count = 0;
    const p = await prepareMarkRead(ctx, { allNotifications: true });
    expect(p.title).toBe('Mark all notifications as read');
    expect(p.details).toEqual(['All notifications (0 unread)']);
    expect(p.warnings).toEqual(['There are no unread notifications.']);
  });

  it('previews a conversation by name and warns when it is already read', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_get_conversation = {
      id: 7,
      name: '',
      type: 1,
      unreadcount: 0,
      members: [
        { id: 1001, fullname: 'Taro Yamada' },
        { id: 2002, fullname: 'Hanako Suzuki' },
      ],
    };
    const p = await prepareMarkRead(ctx, { conversationId: 7 });
    expect(p.title).toBe("Mark 'Hanako Suzuki' as read");
    expect(p.warnings).toEqual(['This conversation has no unread messages.']);
  });

  it('refuses a conversation Moodle cannot find', async () => {
    const { ctx } = createTestContext();
    await expect(prepareMarkRead(ctx, { conversationId: 7 })).rejects.toBeInstanceOf(NotFound);
  });

  it('warns how many ids are missing from the feed', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.message_popup_get_popup_notifications = popupFeed;
    const p = await prepareMarkRead(ctx, { notificationIds: [501, 998, 999] });
    expect(p.warnings).toEqual(['2 ids were not found in your latest 100 notifications.']);
    const found = await prepareMarkRead(ctx, { notificationIds: [501, 502] });
    expect(found.warnings).toEqual([]);
  });

  it('falls back to generic wording when Moodle cannot describe the target', async () => {
    const { ctx } = createTestContext();
    const all = await prepareMarkRead(ctx, { allNotifications: true });
    expect(all.details).toEqual(['All notifications']);
    const some = await prepareMarkRead(ctx, { notificationIds: [5] });
    expect(some.details).toEqual(['Notifications: 1', '1 older notification (ids 5)']);
    expect(some.warnings).toEqual([]); // the feed was unavailable: nothing to compare with
  });

  it('needs exactly one target and valid ids', async () => {
    const { ctx } = createTestContext();
    await expect(prepareMarkRead(ctx, {})).rejects.toThrow('exactly one');
    await expect(prepareMarkRead(ctx, { allNotifications: false })).rejects.toThrow('exactly one');
    await expect(prepareMarkRead(ctx, { allNotifications: true, conversationId: 1 })).rejects.toThrow('exactly one');
    await expect(prepareMarkRead(ctx, { notificationIds: [1], conversationId: 1 })).rejects.toThrow('exactly one');
    await expect(prepareMarkRead(ctx, { notificationIds: [] })).rejects.toBeInstanceOf(InvalidInput);
    await expect(prepareMarkRead(ctx, { notificationIds: [0] })).rejects.toThrow('positive integer');
    const many = Array.from({ length: 31 }, (_, i) => i + 1);
    await expect(prepareMarkRead(ctx, { notificationIds: many })).rejects.toThrow('At most 30');
  });

  it('is a write action', async () => {
    const { ctx } = createTestContext({ scopes: ['moodle:read'] });
    await expect(prepareMarkRead(ctx, { allNotifications: true })).rejects.toBeInstanceOf(Forbidden);
    const off = createTestContext({ user: makeUser({ settings: { writeMode: 'off' } }) });
    await expect(prepareMarkRead(off.ctx, { allNotifications: true })).rejects.toBeInstanceOf(Forbidden);
  });
});

describe('mark_read execution', () => {
  it('marks each notification and reports partial refusals', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_mark_notification_read = (p: Record<string, unknown>) => {
      if (p.notificationid === 2) throw new MoodleError('Invalid notification', 'invalidparameter');
      if (p.notificationid === 3) return { notificationid: 3, warnings: [{ message: 'Not yours.' }] };
      return { notificationid: p.notificationid, warnings: [] };
    };
    const p = await prepareMarkRead(ctx, { notificationIds: [1, 2, 3] });
    const r = await confirmAction(ctx, p.actionId, 'mcp');
    expect(r).toMatchObject({
      status: 'executed',
      message: 'Marked 1 of 3 notifications as read; Moodle refused ids 2, 3.',
    });
    expect(moodle.callsTo('core_message_mark_notification_read')).toEqual([
      { notificationid: 1 },
      { notificationid: 2 },
      { notificationid: 3 },
    ]);
  });

  it('succeeds cleanly and fails when every id is refused', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_mark_notification_read = { warnings: [] };
    const ok = await prepareMarkRead(ctx, { notificationIds: [9] });
    expect((await confirmAction(ctx, ok.actionId, 'mcp')).message).toBe('Marked 1 notification as read.');
    moodle.handlers.core_message_mark_notification_read = { warnings: [{ message: 'Nope.' }] };
    const bad = await prepareMarkRead(ctx, { notificationIds: [9] });
    const r = await confirmAction(ctx, bad.actionId, 'mcp');
    expect(r.status).toBe('failed');
    expect(r.message).toContain('did not mark any of the notifications as read');
  });

  it('marks all notifications for the user', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_mark_all_notifications_as_read = true;
    const p = await prepareMarkRead(ctx, { allNotifications: true });
    const r = await confirmAction(ctx, p.actionId, 'mcp');
    expect(r).toMatchObject({ status: 'executed', message: 'All notifications marked as read.' });
    expect(moodle.callsTo('core_message_mark_all_notifications_as_read')).toEqual([{ useridto: 1001 }]);
  });

  it('marks a whole conversation read', async () => {
    const { ctx, moodle } = createTestContext();
    moodle.handlers.core_message_mark_all_conversation_messages_as_read = null;
    moodle.handlers.core_message_get_conversation = { id: 7, type: 1, unreadcount: 2, members: [] };
    const p = await prepareMarkRead(ctx, { conversationId: 7 });
    const r = await confirmAction(ctx, p.actionId, 'mcp');
    expect(r).toMatchObject({ status: 'executed', message: 'Conversation marked as read.' });
    expect(moodle.callsTo('core_message_mark_all_conversation_messages_as_read')).toEqual([
      { userid: 1001, conversationid: 7 },
    ]);
  });
});
