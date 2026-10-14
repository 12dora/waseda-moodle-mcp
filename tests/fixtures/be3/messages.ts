/** Synthetic messaging fixtures (shapes of core_message_* / message_popup_* responses). */

import type { RawConversation, RawConversationMessages, RawNotification } from '../../../src/core/services/messages';

export const conversations: { conversations: RawConversation[] } = {
  conversations: [
    {
      id: 11,
      name: 'Hanako Suzuki',
      type: 1,
      unreadcount: 2,
      members: [
        { id: 1001, fullname: 'Taro Yamada' },
        { id: 2002, fullname: 'Hanako Suzuki' },
      ],
      messages: [{ id: 5, text: '<p>See you &amp; thanks</p>', timecreated: 1791943200 }],
    },
    {
      id: 12,
      name: 'Seminar Group',
      type: 2,
      unreadcount: 0,
      members: [
        { id: 1001, fullname: 'Taro Yamada' },
        { id: 2002, fullname: 'Hanako Suzuki' },
        { id: 2003, fullname: 'Jiro Tanaka' },
      ],
      messages: [{ id: 6, text: '<p>Agenda attached</p>', timecreated: 1791939600 }],
    },
    {
      id: 13,
      name: '',
      type: 3,
      unreadcount: null,
      members: [{ id: 1001, fullname: 'Taro Yamada' }],
      messages: [],
    },
    {
      id: 14,
      name: '',
      type: 1,
      unreadcount: 1,
      members: [
        { id: 1001, fullname: 'Taro Yamada' },
        { id: 2004, fullname: 'Ken Sato' },
      ],
      messages: [{ id: 7, text: '<p>Unread note</p>', timecreated: 1791937800 }],
    },
  ],
};

/** Newest first, as returned with newest=1; the mapper sorts oldest first. */
export const conversationMessages: RawConversationMessages = {
  id: 11,
  members: [
    { id: 1001, fullname: 'Taro Yamada' },
    { id: 2002, fullname: 'Hanako Suzuki' },
  ],
  messages: [
    { id: 9, useridfrom: 2002, text: '<p>Hello<br>how are you?</p>', timecreated: 1791939600 },
    { id: 8, useridfrom: 1001, text: '<p>Hi</p>', timecreated: 1791937800 },
  ],
};

export const notifications: { notifications: RawNotification[]; unreadcount: number } = {
  unreadcount: 7,
  notifications: [
    {
      id: 1,
      useridfrom: 3,
      subject: 'Seminar &amp; Lab: new file',
      text: '<p>File Slides was created.</p>',
      fullmessage: 'File Slides [1] was created.',
      fullmessagehtml:
        '<p>File <a href="https://moodle.example.com/mod/resource/view.php?id=7001">Slides</a> was created.</p>',
      smallmessage: 'File Slides was created.',
      contexturl: 'https://moodle.example.com/mod/resource/view.php?id=7001',
      timecreated: 1791943200,
      read: false,
      component: 'moodle',
    },
    {
      id: 2,
      useridfrom: -10,
      subject: 'Submission confirmed',
      text: '<p>Submission confirmed &amp; saved</p>',
      fullmessage: '',
      fullmessagehtml: '',
      smallmessage: 'Submission confirmed &amp; saved',
      contexturl: '',
      timecreated: 1791939600,
      read: true,
      component: 'mod_assign',
    },
    {
      id: 3,
      useridfrom: 4,
      subject: 'New post',
      text: '',
      fullmessage: `Course -> Forum -> Topic\n${'x'.repeat(2000)}`,
      fullmessagehtml: '<p>html version</p>',
      smallmessage: '',
      contexturl: 'https://moodle.example.com/mod/forum/discuss.php?d=701',
      timecreated: 1791937800,
      read: false,
      component: 'mod_forum',
    },
    {
      id: 4,
      useridfrom: 5,
      subject: 'Mail only',
      text: '',
      fullmessage: '',
      fullmessagehtml:
        '<div class="navbar"><a href="https://moodle.example.com">Site header</a></div><header><h1>Banner</h1></header><p>The actual message.</p>',
      smallmessage: '',
      contexturl: '',
      timecreated: 1791860400,
      read: true,
      component: 'moodle',
    },
  ],
};

/** core_message_get_conversation (messagelimit=0): header only. */
export const conversationInfoGroupOfTwo: RawConversation = {
  id: 15,
  name: 'Pair Group',
  type: 2,
  unreadcount: 3,
  members: [
    { id: 1001, fullname: 'Taro Yamada' },
    { id: 2002, fullname: 'Hanako Suzuki' },
  ],
  messages: [],
};
