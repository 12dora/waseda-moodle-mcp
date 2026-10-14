import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TEXT_CHARS } from '../../src/core/mcp/render/common';
import { renderTimetable } from '../../src/core/mcp/render/timetable';
import { buildMcpServer } from '../../src/core/mcp/server';
import { getTimetable } from '../../src/core/services/timetable';
import type { Timetable, TimetableClass, TimetableDay } from '../../src/core/types';
import { makeFakeContext } from '../helpers/fake-context';

vi.mock('../../src/core/services/timetable', () => ({ getTimetable: vi.fn() }));

const PERIODS = {
  standard: [{ period: 1, start: '08:50', end: '10:30' }],
  evening: [{ period: 6, start: '18:30', end: '20:10' }],
};

const klass = (patch: Partial<TimetableClass>): TimetableClass => ({
  courseId: 101,
  courseName: 'Strategic Marketing',
  start: '08:50',
  end: '12:20',
  periods: 'P1–2',
  periodFrom: 1,
  periodTo: 2,
  night: false,
  classroom: '11-502',
  campus: '早稲田',
  url: 'https://moodle.example.edu/course/view.php?id=101',
  ...patch,
});

const day = (
  date: string,
  weekday: number,
  classes: TimetableClass[] = [],
  note: string | null = null,
): TimetableDay => ({
  date,
  weekday,
  note,
  classes,
});

const timetable = (patch: Partial<Timetable> = {}): Timetable => ({
  from: '2026-10-19',
  to: '2026-10-21',
  days: [
    day('2026-10-19', 1, [
      klass({}),
      klass({
        courseId: 102,
        courseName: 'Night Strategy',
        start: '18:30',
        end: '22:00',
        periods: 'P6–7',
        night: true,
        classroom: null,
      }),
    ]),
    day('2026-10-20', 2),
    day('2026-10-21', 3, [], 'Classes are held: 創立記念日'),
  ],
  onDemand: [{ courseId: 103, courseName: 'Online Japanese', url: 'u', term: '秋学期', kind: 'on-demand' }],
  unknown: [{ courseId: 104, courseName: 'Mystery Course', url: 'u' }],
  periodTimes: PERIODS,
  scopeMode: 'mine',
  approximate: false,
  ...patch,
});

describe('renderTimetable', () => {
  it('prints a day heading, one line per class with times, periods and room, then the separate lists', () => {
    const text = renderTimetable(timetable());
    expect(text).toContain('Timetable 2026-10-19 to 2026-10-21');
    expect(text).toContain('Mon 10/19 —');
    expect(text).toContain('- 08:50–12:20 Strategic Marketing (P1–2, 11-502) course_id 101');
    expect(text).toContain('- 18:30–22:00 Night Strategy (P6–7 evening) course_id 102');
    expect(text).toContain('Tue 10/20 — no classes');
    expect(text).toContain('Wed 10/21 — no classes (Classes are held: 創立記念日)');
    expect(text).toContain('On-demand / no fixed weekly time');
    expect(text).toContain('Online Japanese (course_id 103)');
    expect(text).toContain('Time unknown');
    expect(text).toContain('Mystery Course (course_id 104)');
  });

  it('names a campus other than Waseda, and says when the day has classes plus a note', () => {
    const text = renderTimetable(
      timetable({
        from: '2026-10-12',
        to: '2026-10-12',
        days: [day('2026-10-12', 1, [klass({ campus: '所沢' })], 'Classes are held: スポーツの日')],
        onDemand: [],
        unknown: [],
      }),
    );
    expect(text).toContain('Timetable 2026-10-12.');
    expect(text).toContain('Mon 10/12 — (Classes are held: スポーツの日)');
    expect(text).toContain('(P1–2, 11-502, 所沢)');
    expect(text).not.toContain('On-demand');
  });

  it('adds the scope and estimate footers', () => {
    const text = renderTimetable(timetable({ scopeMode: 'auto', approximate: true, onDemand: [], unknown: [] }));
    expect(text).toContain('set_my_courses');
    expect(text).toContain('estimated');
  });

  it('stays within the text cap for 14 busy days and says how many entries were cut', () => {
    const days = Array.from({ length: 14 }, (_, i) =>
      day(
        `2026-10-${String(12 + i).padStart(2, '0')}`,
        (i % 7) + 1,
        [1, 2, 3, 4, 5].map((n) =>
          klass({ courseId: n, courseName: `A fairly long course name number ${n} of the term` }),
        ),
      ),
    );
    const text = renderTimetable(timetable({ from: '2026-10-12', to: '2026-10-25', days }));
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 200);
    expect(text).toMatch(/… \d+ more \(ask for fewer days\)/);
  });
});

// ------------------------------------------------------------------ the tool

const open: Array<{ client: Client; server: McpServer }> = [];

async function connect(scopes: Array<'moodle:read' | 'moodle:write'>) {
  const t = makeFakeContext({ scopes });
  const server = buildMcpServer(t.ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({ client, server });
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const { client, server } of open.splice(0)) {
    await client.close();
    await server.close();
  }
});

describe('get_timetable tool', () => {
  it('is a read tool, passes date and days to the service and returns text plus structured data', async () => {
    const data = timetable();
    vi.mocked(getTimetable).mockResolvedValue(data);
    const client = await connect(['moodle:read']);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'get_timetable');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
    const r = await client.callTool({ name: 'get_timetable', arguments: { date: '2026-10-19', days: 3 } });
    expect(vi.mocked(getTimetable).mock.calls[0]?.[1]).toEqual({ date: '2026-10-19', days: 3 });
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toContain('Mon 10/19');
    expect(r.structuredContent).toMatchObject({ from: '2026-10-19', days: [{ date: '2026-10-19' }, {}, {}] });
  });

  it('defaults to no arguments and rejects a malformed date or too many days', async () => {
    vi.mocked(getTimetable).mockResolvedValue(timetable());
    const client = await connect(['moodle:read']);
    await client.callTool({ name: 'get_timetable', arguments: {} });
    expect(vi.mocked(getTimetable).mock.calls[0]?.[1]).toEqual({ date: undefined, days: undefined });
    for (const args of [{ date: '10/19' }, { date: 'yesterday' }, { days: 15 }, { days: 0 }]) {
      expect((await client.callTool({ name: 'get_timetable', arguments: args })).isError, JSON.stringify(args)).toBe(
        true,
      );
    }
    expect(vi.mocked(getTimetable)).toHaveBeenCalledTimes(1);
  });

  it('is mentioned in the server instructions', async () => {
    const client = await connect(['moodle:read']);
    expect(client.getInstructions()).toMatch(/get_timetable/);
  });
});
