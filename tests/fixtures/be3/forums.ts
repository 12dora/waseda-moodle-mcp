/** Synthetic forum fixtures (shapes of mod_forum / mod_hsuforum responses). */

import type { RawDiscussionList, RawForum, RawForumPosts, RawHsuPosts } from '../../../src/core/services/forums';

const BASE = 'https://moodle.example.com';

export const forumsC1: RawForum[] = [
  {
    id: 3001,
    course: 9001,
    cmid: 7010,
    type: 'news',
    name: 'Announcements',
    intro: '<p>News &amp; updates</p>',
    duedate: 0,
    numdiscussions: 2,
  },
  { id: 3002, course: 9001, cmid: 7011, type: 'general', name: 'Q&amp;A', intro: '', duedate: 0, numdiscussions: 0 },
];

export const forumsC2: RawForum[] = [
  { id: 3003, course: 9002, cmid: 7012, type: 'news', name: 'Announcements', intro: '', duedate: 0, numdiscussions: 1 },
];

export const hsuForumsC1: RawForum[] = [
  {
    id: 4001,
    course: 9001,
    cmid: 7020,
    type: 'general',
    name: 'Advanced Forum',
    intro: '<p>Group talk</p>',
    duedate: 1792508340,
    numdiscussions: 1,
  },
];

export const forumDiscussions: RawDiscussionList = {
  discussions: [
    {
      id: 801,
      discussion: 701,
      name: 'Midterm info',
      subject: 'Midterm info',
      userfullname: 'Hanako Suzuki',
      created: 1791860400,
      modified: 1791860400,
      timemodified: 1791939600, // 2026-10-14 10:00 JST
      numreplies: 3,
      numunread: 1,
      pinned: true,
    },
    {
      id: 802,
      discussion: 702,
      name: 'Room change &amp; time',
      subject: 'Room change &amp; time',
      userfullname: 'Hanako Suzuki',
      created: 1791169200,
      modified: 1791169200,
      timemodified: 1791169200, // 2026-10-05 12:00 JST
      numreplies: 0,
      numunread: 0,
      pinned: false,
    },
  ],
};

export const forumDiscussionsC2: RawDiscussionList = {
  discussions: [
    {
      id: 811,
      discussion: 711,
      name: 'Welcome',
      subject: 'Welcome',
      userfullname: 'Ken Sato',
      created: 1791937800,
      timemodified: 1791943200, // 2026-10-14 11:00 JST
      numreplies: 0,
      numunread: 1,
      pinned: false,
    },
  ],
};

export const hsuDiscussions: RawDiscussionList = {
  discussions: [
    {
      id: 901,
      discussion: 751,
      name: 'Group topic',
      subject: 'Group topic',
      userfullname: 'Jiro Tanaka',
      created: 1791937800,
      modified: 1791937800,
      timemodified: 1791943200,
      numreplies: '2', // hsuforum returns the count as text
      numunread: 2,
      pinned: false,
    },
  ],
};

export const forumPosts: RawForumPosts = {
  forumid: 3001,
  courseid: 9001,
  posts: [
    {
      id: 801,
      subject: 'Midterm info',
      message: '<p>Bring your <strong>ID</strong>.</p>',
      author: { id: 2002, fullname: 'Hanako Suzuki' },
      hasparent: false,
      parentid: null,
      timecreated: 1791860400,
      timemodified: 1791860400,
      unread: false,
      attachments: [
        {
          filename: 'rules.pdf',
          filesize: 100,
          url: `${BASE}/pluginfile.php/222/mod_forum/attachment/801/rules.pdf`,
          mimetype: 'application/pdf',
          timemodified: 1791860400,
        },
      ],
      capabilities: { reply: true },
    },
    {
      id: 803,
      subject: 'Re: Midterm info',
      message: '<p>Thanks &amp; see you.</p>',
      author: { id: 1001, fullname: 'Taro Yamada' },
      hasparent: true,
      parentid: 801,
      timecreated: 1791939600,
      timemodified: 1791939600,
      unread: true,
      attachments: [],
      capabilities: { reply: true },
    },
  ],
};

/** Deliberately out of order: the mapper sorts oldest first. */
export const hsuPosts: RawHsuPosts = {
  posts: [
    {
      id: 952,
      parent: 951,
      created: 1791943200,
      modified: 1791943200,
      subject: 'Re: Group topic',
      message: '<p>Anonymous reply</p>',
      userfullname: null,
      postread: false,
      canreply: true,
    },
    {
      id: 951,
      parent: 0,
      created: 1791937800,
      modified: 1791937800,
      subject: 'Group topic',
      message: '<p>Hello team</p>',
      userfullname: 'Jiro Tanaka',
      attachments: [
        {
          filename: 'notes.txt',
          filepath: '/',
          filesize: 5,
          fileurl: `${BASE}/webservice/pluginfile.php/666/mod_hsuforum/attachment/951/notes.txt`,
          mimetype: 'text/plain',
          timemodified: 1791937800,
        },
      ],
      postread: true,
      canreply: true,
    },
  ],
};
