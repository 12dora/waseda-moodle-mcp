import { describe, expect, it } from 'vitest';
import { calendarReadTools, calendarWriteTools } from '../../src/core/mcp/tools/calendar';

const calendarTools = [...calendarReadTools, ...calendarWriteTools];

import type { ToolDef } from '../../src/core/mcp/tools/define';
import { createTestContext } from '../helpers/fake-context-be4';
import { makeWebApi } from '../services/web-channel';

/** Invented data only. */
const START = Date.parse('2030-12-02T10:30:00+09:00') / 1000;

const tool = (name: string): ToolDef => {
  const def = (calendarTools as readonly ToolDef[]).find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
};

function webCtx() {
  const api = makeWebApi({
    handlers: {
      core_calendar_get_calendar_events: {
        events: [{ id: 1, name: '面談', eventtype: 'user', courseid: 0, timestart: START, timeduration: 0 }],
        warnings: [],
      },
    },
  });
  const { ctx } = createTestContext();
  return { ...ctx, moodle: async () => api };
}

describe('calendar tools', () => {
  it('list_calendar_events returns text and structured content its output schema accepts', async () => {
    const def = tool('list_calendar_events');
    const out = await def.run(webCtx(), def.input.parse({ days_ahead: 7 }));
    expect(out.text).toContain('Personal calendar events');
    expect(out.text).toContain('面談 (personal, event_id 1)');
    expect(def.output.safeParse(JSON.parse(JSON.stringify(out.data))).success).toBe(true);
  });

  it('prepare_calendar_event returns a preview its output schema accepts', async () => {
    const def = tool('prepare_calendar_event');
    const args = def.input.parse({
      action: 'create',
      name: 'ゼミ準備',
      start: '2030-12-02T10:30',
      duration_minutes: 60,
    });
    const out = await def.run(webCtx(), args);
    expect(out.text).toContain("Action preview: Create calendar event 'ゼミ準備'");
    expect(def.output.safeParse(JSON.parse(JSON.stringify(out.data))).success).toBe(true);
  });

  it('prepare_calendar_event input rejects unknown actions and negative durations', () => {
    const { input } = tool('prepare_calendar_event');
    expect(input.safeParse({ action: 'move' }).success).toBe(false);
    expect(input.safeParse({ action: 'create', duration_minutes: -5 }).success).toBe(false);
  });
});
