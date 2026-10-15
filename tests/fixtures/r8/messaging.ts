/** Synthetic fixtures for people search, paging and mark-read (invented names and ids). */

import type { RawConversationMessages } from '../../../src/core/services/messages';

/** Newest first (as with newest=true): ids 20 … 11. */
export function manyMessages(): RawConversationMessages {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: 20 - i,
    useridfrom: i % 2 === 0 ? 2002 : 1001,
    text: `<p>message ${20 - i}</p>`,
    timecreated: 1791943200 - i * 60,
  }));
  return {
    id: 11,
    members: [
      { id: 1001, fullname: 'Taro Yamada' },
      { id: 2002, fullname: 'Hanako Suzuki' },
    ],
    messages,
  };
}

export const popupFeed = {
  unreadcount: 2,
  notifications: [
    { id: 501, subject: 'Grade &amp; feedback posted', smallmessage: 'Graded', timecreated: 1791943200, read: false },
    { id: 502, subject: 'New forum post', smallmessage: 'Posted', timecreated: 1791939600, read: false },
  ],
};
