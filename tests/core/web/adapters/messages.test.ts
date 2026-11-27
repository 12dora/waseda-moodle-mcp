import { describe, expect, it } from 'vitest';
import { messageFunctions } from '../../../../src/core/moodle/web/adapters/messages';
import { makeFakeWebSession } from '../../../helpers/fake-web-session';

describe('messageFunctions', () => {
  it('answers the unread notification count from the popup count (ajax)', async () => {
    const seen: Record<string, unknown>[] = [];
    const web = makeFakeWebSession({
      ajax: {
        message_popup_get_unread_popup_notification_count: (args: Record<string, unknown>) => {
          seen.push(args);
          return 3;
        },
      },
    });
    const fn = messageFunctions.core_message_get_unread_notification_count;
    if (!fn) throw new Error('missing adapter');
    expect(await fn(web, { useridto: 4242 }, {})).toBe(3);
    expect(seen).toEqual([{ useridto: 4242 }]);
    expect(web.calls).toEqual(['ajax message_popup_get_unread_popup_notification_count']);
  });
});
