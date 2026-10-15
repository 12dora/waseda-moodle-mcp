import { describe, expect, it } from 'vitest';
import { MoodleError, NotFound } from '../../src/core/errors';
import { getConversation, listConversations, mapConversation } from '../../src/core/services/messages';
import { listNotifications, mapNotification } from '../../src/core/services/messages/notifications';
import { fromTs } from '../../src/core/time';
import {
  conversationInfoGroupOfTwo,
  conversationMessages,
  conversations,
  notifications,
} from '../fixtures/be3/messages';
import { manyMessages } from '../fixtures/r8/messaging';
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
      messagelimit: 1,
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

describe('paging (round 8)', () => {
  it('list_messages passes offset and a numeric type to Moodle', async () => {
    const { ctx, calls } = makeFakeContext({ core_message_get_conversations: conversations });
    await listConversations(ctx, { limit: 5, offset: 10, type: 'group' });
    expect(calls[0]?.params).toEqual({ userid: 1001, limitfrom: 10, limitnum: 5, type: 2 });
  });

  it('get_conversation lists member ids and pages with offset', async () => {
    const { ctx, calls } = makeFakeContext({ core_message_get_conversation_messages: manyMessages() });
    const c = await getConversation(ctx, 11, { limit: 10, offset: 10 });
    expect(calls[0]?.params).toMatchObject({ limitfrom: 10, limitnum: 10 });
    expect(c.members).toEqual([
      { id: 1001, name: 'Taro Yamada' },
      { id: 2002, name: 'Hanako Suzuki' },
    ]);
    expect(c.messages).toHaveLength(10);
    // a full page means there may be older messages: the next page starts after the ones shown
    expect(c.nextOffset).toBe(20);
  });

  it('a short page ends the history', async () => {
    const { ctx } = makeFakeContext({ core_message_get_conversation_messages: manyMessages() });
    expect((await getConversation(ctx, 11, { limit: 30 })).nextOffset).toBeNull();
  });

  it('pages far back: every page asks Moodle for its own window', async () => {
    const { ctx, calls } = makeFakeContext({
      core_message_get_conversation_messages: (p: Record<string, unknown>) => {
        const all = manyMessages();
        const from = Number(p.limitfrom) % 10;
        return { ...all, messages: all.messages?.slice(from, from + Number(p.limitnum)) };
      },
    });
    const page = await getConversation(ctx, 11, { limit: 4, offset: 240 });
    expect(calls[0]?.params).toMatchObject({ limitfrom: 240, limitnum: 4 });
    expect(page.messages).toHaveLength(4);
    expect(page.nextOffset).toBe(244);
    expect(await getConversation(ctx, 11, { limit: 4, offset: 248 })).toMatchObject({ nextOffset: null });
  });

  it('takes the last message from the conversation info when paging, not from the page', async () => {
    const info = {
      ...conversationInfoGroupOfTwo,
      messages: [{ id: 99, text: '<p>latest news</p>', timecreated: 1791950000 }],
    };
    const { ctx } = makeFakeContext({
      core_message_get_conversation_messages: manyMessages(),
      core_message_get_conversation: info,
    });
    const c = await getConversation(ctx, 15, { limit: 10, offset: 10 });
    expect(c.summary.lastAt).toBe(fromTs(1791950000));
    expect(c.summary.lastMessage).toBe('latest news');
    // without the header, an old page must not pass for the latest message
    const bare = makeFakeContext({ core_message_get_conversation_messages: manyMessages() });
    const old = await getConversation(bare.ctx, 11, { limit: 10, offset: 10 });
    expect(old.summary).toMatchObject({ lastMessage: null, lastAt: null });
  });

  it('caps the members in the result at 50', async () => {
    const members = Array.from({ length: 60 }, (_, i) => ({ id: 3000 + i, fullname: `Member ${i}` }));
    const { ctx } = makeFakeContext({
      core_message_get_conversation_messages: manyMessages(),
      core_message_get_conversation: { id: 11, name: 'Big', type: 2, unreadcount: 0, members, messages: [] },
    });
    const c = await getConversation(ctx, 11);
    expect(c.members).toHaveLength(50);
    expect(c.summary.memberIds).toHaveLength(50);
  });
});

describe('notification paging (round 8)', () => {
  it('passes offset and returns the next offset while the feed continues', async () => {
    const { ctx, calls } = makeFakeContext({ message_popup_get_popup_notifications: notifications });
    const r = await listNotifications(ctx, { limit: 2, offset: 4 });
    expect(calls[0]?.params).toMatchObject({ limit: 2, offset: 4 });
    expect(r.nextOffset).toBe(6);
    expect(r.notifications[0]).toMatchObject({ id: 1, component: 'moodle' });
  });

  it('unreadOnly counts only the feed entries it consumed', async () => {
    const { ctx } = makeFakeContext({ message_popup_get_popup_notifications: notifications });
    // unread are ids 1 and 3 (positions 0 and 2): the second page starts after the third entry
    const r = await listNotifications(ctx, { unreadOnly: true, limit: 2, offset: 10 });
    expect(r.notifications.map((n) => n.id)).toEqual([1, 3]);
    expect(r.nextOffset).toBe(13);
  });

  it('ends the feed when Moodle returns fewer entries than asked', async () => {
    const { ctx } = makeFakeContext({ message_popup_get_popup_notifications: notifications });
    const r = await listNotifications(ctx, { limit: 20 });
    expect(r.notifications).toHaveLength(4);
    expect(r.nextOffset).toBeNull();
  });
});
