import { describe, expect, it } from 'vitest';
import { MoodleError, NotFound } from '../../src/core/errors';
import {
  getConversation,
  listConversations,
  listNotifications,
  mapConversation,
  mapNotification,
} from '../../src/core/services/messages';
import {
  conversationInfoGroupOfTwo,
  conversationMessages,
  conversations,
  notifications,
} from '../fixtures/be3/messages';
import { makeFakeContext } from '../helpers/fake-context-be3';

describe('mapConversation', () => {
  const [priv, group, self] = conversations.conversations;

  it('names private chats after the other member and decodes the preview', () => {
    expect(mapConversation(priv!, 1001)).toEqual({
      id: 11,
      name: 'Hanako Suzuki',
      type: 'private',
      unread: 2,
      lastMessage: 'See you & thanks',
      lastAt: '2026-10-14T11:00:00+09:00',
      memberIds: [1001, 2002],
    });
  });

  it('handles groups and the personal space (null unread count)', () => {
    expect(mapConversation(group!, 1001)).toMatchObject({
      name: 'Seminar Group',
      type: 'group',
      unread: 0,
      memberIds: [1001, 2002, 2003],
    });
    expect(mapConversation(self!, 1001)).toMatchObject({
      name: 'Personal space',
      type: 'self',
      unread: 0,
      lastMessage: null,
      lastAt: null,
    });
  });

  it('falls back to the other members when the conversation has no name', () => {
    expect(mapConversation(conversations.conversations[3]!, 1001).name).toBe('Ken Sato');
  });
});

describe('listConversations', () => {
  it('asks for the user own conversations', async () => {
    const { ctx, calls } = makeFakeContext({ core_message_get_conversations: conversations });
    const list = await listConversations(ctx, { limit: 3 });
    expect(list.map((c) => c.id)).toEqual([11, 12, 13]);
    expect(calls).toEqual([
      { fn: 'core_message_get_conversations', params: { userid: 1001, limitfrom: 0, limitnum: 3 } },
    ]);
  });

  it('filters unread client-side from a wider window', async () => {
    const { ctx, calls } = makeFakeContext({ core_message_get_conversations: conversations });
    const list = await listConversations(ctx, { unreadOnly: true, limit: 20 });
    expect(list.map((c) => c.id)).toEqual([11, 14]);
    expect(calls[0]?.params.limitnum).toBe(50);
    expect(await listConversations(makeFakeContext({ core_message_get_conversations: {} }).ctx)).toEqual([]);
  });
});

describe('getConversation', () => {
  it('returns messages oldest first with authors and fromMe', async () => {
    const { ctx, calls } = makeFakeContext({ core_message_get_conversation_messages: conversationMessages });
    const c = await getConversation(ctx, 11);
    expect(calls[0]).toEqual({
      fn: 'core_message_get_conversation_messages',
      params: { currentuserid: 1001, convid: 11, limitfrom: 0, limitnum: 30, newest: true },
    });
    expect(c.messages.map((m) => [m.id, m.author, m.fromMe, m.sentAt])).toEqual([
      [8, 'Taro Yamada', true, '2026-10-14T09:30:00+09:00'],
      [9, 'Hanako Suzuki', false, '2026-10-14T10:00:00+09:00'],
    ]);
    expect(c.messages[1]?.text).toContain('Hello');
    expect(c.messages[1]?.text).toContain('how are you?');
    // no core_message_get_conversation here: type and name are inferred from the members
    expect(c.summary).toMatchObject({
      id: 11,
      name: 'Hanako Suzuki',
      type: 'private',
      memberIds: [1001, 2002],
      lastAt: '2026-10-14T10:00:00+09:00',
    });
  });

  it('takes type, name and unread count from core_message_get_conversation', async () => {
    const { ctx, calls } = makeFakeContext({
      core_message_get_conversation_messages: conversationMessages,
      core_message_get_conversation: conversationInfoGroupOfTwo,
    });
    const c = await getConversation(ctx, 15);
    expect(calls.find((x) => x.fn === 'core_message_get_conversation')?.params).toEqual({
      userid: 1001,
      conversationid: 15,
      includecontactrequests: false,
      includeprivacyinfo: false,
      memberlimit: 0,
      memberoffset: 0,
      messagelimit: 0,
      messageoffset: 0,
      newestmessagesfirst: true,
    });
    // a two-person group is a group, not a private chat
    expect(c.summary).toMatchObject({ id: 15, name: 'Pair Group', type: 'group', unread: 3, memberIds: [1001, 2002] });
    expect(c.summary.lastAt).toBe('2026-10-14T10:00:00+09:00');
  });

  it('infers group / self from the member count and honours the limit', async () => {
    const group = makeFakeContext({
      core_message_get_conversation_messages: {
        id: 12,
        members: [
          { id: 1001, fullname: 'Taro Yamada' },
          { id: 2, fullname: 'A' },
          { id: 3, fullname: 'B' },
        ],
        messages: [],
      },
    });
    const g = await getConversation(group.ctx, 12, { limit: 5 });
    expect(g.summary).toMatchObject({ type: 'group', name: 'A, B', lastMessage: null, lastAt: null });
    expect(group.calls[0]?.params.limitnum).toBe(5);
    const self = makeFakeContext({
      core_message_get_conversation_messages: {
        id: 13,
        members: [{ id: 1001, fullname: 'Taro Yamada' }],
        messages: [],
      },
    });
    expect((await getConversation(self.ctx, 13)).summary).toMatchObject({ type: 'self', name: 'Personal space' });
  });

  it('maps a missing conversation to NotFound', async () => {
    const { ctx } = makeFakeContext({
      core_message_get_conversation_messages: () => {
        throw new MoodleError('Conversation does not exist', 'errorconversationdoesnotexist');
      },
    });
    await expect(getConversation(ctx, 99)).rejects.toBeInstanceOf(NotFound);
    const other = makeFakeContext({
      core_message_get_conversation_messages: () => {
        throw new MoodleError('Something else', 'accessexception');
      },
    });
    await expect(getConversation(other.ctx, 99)).rejects.toBeInstanceOf(MoodleError);
  });
});

describe('notifications', () => {
  const [n1, n2, n3, n4] = notifications.notifications;

  it('mapNotification prefers the small message and decodes the subject', () => {
    expect(mapNotification(n1!)).toMatchObject({
      id: 1,
      subject: 'Seminar & Lab: new file',
      text: 'File Slides was created.',
      sender: null,
      sentAt: '2026-10-14T11:00:00+09:00',
      read: false,
      url: 'https://moodle.example.com/mod/resource/view.php?id=7001',
      component: 'moodle',
    });
    expect(mapNotification(n2!)).toMatchObject({
      text: 'Submission confirmed & saved',
      url: null,
      read: true,
      component: 'mod_assign',
    });
  });

  it('falls back to the plain full message (capped at 600 characters)', () => {
    const t = mapNotification(n3!).text;
    expect(t.startsWith('Course -> Forum -> Topic\nxxx')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(601);
    expect(t.length).toBeGreaterThan(500);
  });

  it('uses the html body last and strips the navbar and header', () => {
    const t = mapNotification(n4!).text;
    expect(t).toContain('The actual message.');
    expect(t).not.toContain('Site header');
    expect(t).not.toContain('Banner');
  });

  it('listNotifications reports the unread count from the feed', async () => {
    const { ctx, calls } = makeFakeContext({ message_popup_get_popup_notifications: notifications });
    const r = await listNotifications(ctx, { limit: 2 });
    expect(r.unreadCount).toBe(7);
    expect(r.notifications.map((n) => n.id)).toEqual([1, 2]);
    expect(calls).toEqual([
      {
        fn: 'message_popup_get_popup_notifications',
        params: { useridto: 1001, newestfirst: true, limit: 2, offset: 0 },
      },
    ]);
  });

  it('unreadOnly filters client-side from a wider window', async () => {
    const { ctx, calls } = makeFakeContext({ message_popup_get_popup_notifications: notifications });
    const r = await listNotifications(ctx, { unreadOnly: true, limit: 20 });
    expect(r.notifications.map((n) => n.id)).toEqual([1, 3]);
    expect(calls[0]?.params.limit).toBe(60);
  });
});
