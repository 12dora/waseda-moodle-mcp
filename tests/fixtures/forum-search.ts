/** Synthetic forum / message-search fixtures (invented names and ids; shapes of the Moodle responses). */

import type { RawDiscussionList, RawForum } from '../../src/core/services/forums';

// the general forum is listed first on purpose: search must still read the announcement forum first
export const searchForums: RawForum[] = [
  { id: 3002, course: 9001, cmid: 7011, type: 'general', name: 'Q&amp;A', intro: '', numdiscussions: 2 },
  { id: 3001, course: 9001, cmid: 7010, type: 'news', name: 'Announcements', intro: '', numdiscussions: 3 },
];

export const searchHsuForums: RawForum[] = [
  { id: 4001, course: 9001, cmid: 7020, type: 'general', name: 'Advanced Forum', intro: '', numdiscussions: 1 },
];

export const searchDiscussionsByForum: Record<number, RawDiscussionList> = {
  3001: {
    discussions: [
      {
        id: 801,
        discussion: 701,
        subject: 'Midterm exam room',
        message: '<p>The exam will be held in <b>Room 301</b>. Bring your ID.</p>',
        userfullname: 'Hanako Suzuki',
        created: 1791860400,
        timemodified: 1791939600, // 2026-10-14 10:00 JST
        numreplies: 1,
        numunread: 0,
        pinned: false,
      },
      {
        id: 802,
        discussion: 702,
        subject: 'Guest lecture',
        message: '<p>A guest speaks about the midterm exam schedule and the reading list.</p>',
        userfullname: 'Hanako Suzuki',
        created: 1791860400,
        timemodified: 1791943200, // 2026-10-14 11:00 JST (newer than 801)
        numreplies: 0,
        numunread: 1,
        pinned: false,
      },
      {
        id: 803,
        discussion: 703,
        subject: 'Ｒｅｐｏｒｔ　ＤＵＥ',
        message: '<p>Submit by Friday.</p>',
        userfullname: 'Hanako Suzuki',
        created: 1791860400,
        timemodified: 1791850000,
        numreplies: 0,
        numunread: 0,
        pinned: false,
      },
    ],
  },
  3002: {
    discussions: [
      {
        id: 811,
        discussion: 711,
        subject: 'Question about the report',
        message: '<p>When is the report due? Also what about the midterm?</p>',
        userfullname: 'Ken Sato',
        created: 1791860400,
        timemodified: 1791946800,
        numreplies: 2,
        numunread: 0,
        pinned: false,
      },
    ],
  },
};

export const searchHsuDiscussions: RawDiscussionList = {
  discussions: [
    {
      id: 901,
      discussion: 751,
      subject: 'Group topic',
      message: '<p>Who wants to review the midterm exam together?</p>',
      userfullname: 'Jiro Tanaka',
      created: 1791937800,
      timemodified: 1791943300,
      numreplies: '2',
      numunread: 2,
      pinned: false,
    },
  ],
};

export const messageSearchResponse = {
  contacts: [
    {
      userid: 2002,
      fullname: 'Ken Sato',
      lastmessage: 'Can we meet before the <b>midterm</b>?',
      lastmessagedate: 1791943200,
      sentfromcurrentuser: false,
      conversationid: 55,
    },
    {
      userid: 2003,
      fullname: 'Hanako Suzuki',
      lastmessage: 'See you at the midterm',
      lastmessagedate: 1791850000,
      sentfromcurrentuser: true,
      conversationid: null,
    },
  ],
};
