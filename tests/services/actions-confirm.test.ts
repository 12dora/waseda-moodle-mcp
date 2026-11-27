import { describe, expect, it } from 'vitest';
import type { MoodleChannel } from '../../src/core/context';
import { NeedsReconnect } from '../../src/core/errors';
import { confirmAction } from '../../src/core/services/actions/confirm';
import { savePreview } from '../../src/core/services/actions/shared';
import { UNCERTAIN_MARK } from '../../src/core/services/actions/target';
import { makeFakeContext } from '../helpers/fake-context';

const COMPLETE = 'core_completion_update_activity_completion_status_manually';
const SETTLE = 'core_course_get_recent_courses';

/** A completion action prepared on `prepared`; the client reports `writesSent` like the real ones. */
function setup(prepared: MoodleChannel) {
  const t = makeFakeContext({ scopes: ['moodle:read', 'moodle:write'], responses: { [SETTLE]: [] } });
  const state = { channel: prepared, writes: 0 };
  Object.defineProperty(t.api, 'channel', { get: () => state.channel, configurable: true });
  Object.defineProperty(t.api, 'writesSent', { get: () => state.writes, configurable: true });
  const prepare = () =>
    savePreview(t.ctx, {
      kind: 'completion',
      title: 'Mark complete',
      details: [],
      warnings: [],
      payload: { cmid: 99101, completed: true, url: null },
    });
  return { t, state, prepare };
}

describe('confirmAction: the channel of a fresh client', () => {
  it('a web-prepared action on a client still predicting ws: one read settles it, then it runs', async () => {
    const { t, state, prepare } = setup('web');
    const p = await prepare();
    state.channel = 'ws'; // a fresh client of another isolate whose site flag is still on
    t.api.set(SETTLE, () => {
      state.channel = 'web'; // the first call fell back to the web session
      return [];
    });
    t.api.set(COMPLETE, { status: true });
    const before = t.api.calls.length;
    const res = await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(res.status).toBe('executed');
    expect(t.api.calls.slice(before).map((c) => c.fn)).toEqual([SETTLE, COMPLETE]);
  });
});

describe('confirmAction: a reconnect during execute', () => {
  it('before anything was written: handed back, still pending', async () => {
    const { t, prepare } = setup('ws');
    const p = await prepare();
    t.api.set(COMPLETE, () => {
      throw new NeedsReconnect();
    });
    await expect(confirmAction(t.ctx, p.actionId, 'mcp')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(t.state.actions.get(p.actionId)?.status).toBe('pending');
  });

  it('after a write was sent (e.g. a read after the POST): failed as uncertain, never handed back', async () => {
    const { t, state, prepare } = setup('ws');
    const p = await prepare();
    t.api.set(COMPLETE, () => {
      state.writes++; // the write left
      throw new NeedsReconnect(); // the follow-up page found the session over
    });
    const res = await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(res.status).toBe('failed');
    expect(res.message).toContain(UNCERTAIN_MARK);
    expect(t.state.actions.get(p.actionId)?.status).toBe('failed');
    // a second confirm answers from the stored row instead of writing again
    const again = await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(again.status).toBe('failed');
    expect(t.api.count(COMPLETE)).toBe(1);
  });

  it('writes sent before the executor started (the settling read) do not count', async () => {
    const { t, state, prepare } = setup('ws');
    const p = await prepare();
    state.writes = 4;
    t.api.set(COMPLETE, () => {
      throw new NeedsReconnect();
    });
    await expect(confirmAction(t.ctx, p.actionId, 'mcp')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(t.state.actions.get(p.actionId)?.status).toBe('pending');
  });
});
