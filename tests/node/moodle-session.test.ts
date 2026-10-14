import { describe, expect, it } from 'vitest';
import { createMoodleProvider, isCacheableRead, ReadCache } from '../../src/node/moodle-session';

function fakeFetch() {
  const bodies: string[] = [];
  const impl = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

describe('createMoodleProvider', () => {
  it('gives each invocation a fresh client with its own call budget (200)', async () => {
    const { impl } = fakeFetch();
    const provider = createMoodleProvider({ token: 't', moodleUserId: 1, fetch: impl, cache: new ReadCache(0) });
    const first = await provider();
    for (let i = 0; i < 100; i++) await first.call('core_course_get_contents', { courseid: i });
    expect(first.callsMade).toBe(100);
    const second = await provider();
    expect(second).not.toBe(first);
    expect(second.callsMade).toBe(0);
  });

  it('memoises reads across clients for the TTL only, and writes invalidate', async () => {
    const { impl, bodies } = fakeFetch();
    let now = 1000;
    const cache = new ReadCache(5000, () => now);
    const provider = createMoodleProvider({ token: 't', moodleUserId: 1, fetch: impl, cache });
    const read = async () => (await provider()).call('core_course_get_contents', { courseid: 7 });
    await read();
    await read();
    expect(bodies).toHaveLength(1);
    now += 6000;
    await read();
    expect(bodies).toHaveLength(2);
    await (await provider()).call('mod_assign_save_submission', { assignmentid: 1 });
    await read();
    expect(bodies).toHaveLength(4); // the write itself + the re-read after invalidation
  });

  it('classifies functions', () => {
    expect(isCacheableRead('core_course_get_contents')).toBe(true);
    expect(isCacheableRead('core_files_get_unused_draft_itemid')).toBe(false);
    expect(isCacheableRead('mod_assign_save_submission')).toBe(false);
  });
});
