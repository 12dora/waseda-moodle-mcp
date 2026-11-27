import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoodleChannel } from '../../src/core/context';
import { createMoodleProvider, isCacheableRead, ReadCache } from '../../src/node/moodle-session';

const { createChannelClient } = vi.hoisted(() => ({ createChannelClient: vi.fn() }));
vi.mock('../../src/core/moodle/web/channel', () => ({ createChannelClient }));

const OPTIONS = { moodleUserId: 7001, mobileService: false, token: null, session: null };
let clients: Array<ReturnType<typeof newClient>>;
let channel: MoodleChannel;

const newClient = () => ({
  baseUrl: 'https://wsdmoodle.waseda.jp',
  moodleUserId: 7001,
  callsMade: 0,
  writesSent: 2,
  channel,
  call: vi.fn(async (..._args: unknown[]) => ({})),
  fetchFile: vi.fn(),
  uploadToDraft: vi.fn(),
});

function fakeClient() {
  const client = newClient();
  clients.push(client);
  return client;
}

const sent = () => clients.flatMap((c) => c.call.mock.calls);

beforeEach(() => {
  clients = [];
  channel = 'web';
  createChannelClient.mockReset().mockImplementation(fakeClient);
});

describe('createMoodleProvider', () => {
  it('builds a fresh client per invocation from the current options', async () => {
    const options = vi.fn(() => OPTIONS);
    const provider = createMoodleProvider(options, new ReadCache());
    const first = await provider();
    const second = await provider();
    expect(second).not.toBe(first);
    expect(options).toHaveBeenCalledTimes(2);
    expect(createChannelClient).toHaveBeenLastCalledWith(OPTIONS);
    expect(first.channel).toBe('web');
    channel = 'ws';
    expect((await provider()).channel).toBe('ws');
  });

  it('memoises reads across clients for the TTL only, and writes invalidate', async () => {
    let now = 1000;
    const provider = createMoodleProvider(() => OPTIONS, new ReadCache(5000, () => now));
    const read = async () => (await provider()).call('core_course_get_contents', { courseid: 99101 });
    await read();
    await read();
    expect(sent()).toHaveLength(1);
    now += 6000;
    await read();
    expect(sent()).toHaveLength(2);
    await (await provider()).call('mod_assign_save_submission', { assignmentid: 1 });
    await read();
    expect(sent()).toHaveLength(4); // the write itself + the re-read after invalidation
  });

  it('passes the hint on and never shares a hinted answer', async () => {
    const provider = createMoodleProvider(() => OPTIONS, new ReadCache());
    const params = { courseids: [99101] };
    const read = async (cmid?: number) =>
      (await provider()).call('mod_assign_get_assignments', params, cmid === undefined ? undefined : { cmid });
    await read(1);
    await read(2);
    await read();
    await read();
    expect(sent()).toEqual([
      ['mod_assign_get_assignments', params, { cmid: 1 }],
      ['mod_assign_get_assignments', params, { cmid: 2 }],
      ['mod_assign_get_assignments', params],
    ]);
    await (await provider()).call('mod_assign_save_submission', { assignmentid: 1 }, { cmid: 1 });
    expect(sent().at(-1)).toEqual(['mod_assign_save_submission', { assignmentid: 1 }, { cmid: 1 }]);
  });

  it('a messages hint (announcement bodies) is passed on and not shared with the plain read', async () => {
    const provider = createMoodleProvider(() => OPTIONS, new ReadCache());
    const params = { forumid: 7101 };
    await (await provider()).call('mod_forum_get_forum_discussions', params);
    await (await provider()).call('mod_forum_get_forum_discussions', params, { messages: true });
    expect(sent()).toEqual([
      ['mod_forum_get_forum_discussions', params],
      ['mod_forum_get_forum_discussions', params, { messages: true }],
    ]);
  });

  it('reports the inner client writesSent', async () => {
    expect((await createMoodleProvider(() => OPTIONS, new ReadCache())()).writesSent).toBe(2);
  });

  it('passes uploads on with their hint', async () => {
    const client = await createMoodleProvider(() => OPTIONS, new ReadCache())();
    const file = { name: 'report.pdf', body: new Uint8Array(1), size: 1 };
    await client.uploadToDraft(file, 0, { cmid: 5 });
    expect(clients[0]?.uploadToDraft).toHaveBeenCalledWith(file, 0, { cmid: 5 });
  });

  it('classifies functions', () => {
    expect(isCacheableRead('core_course_get_contents')).toBe(true);
    expect(isCacheableRead('core_files_get_unused_draft_itemid')).toBe(false);
    expect(isCacheableRead('mod_assign_save_submission')).toBe(false);
  });
});
