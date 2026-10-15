import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TEXT_CHARS } from '../../src/core/mcp/render/common';
import { renderTimetable } from '../../src/core/mcp/render/timetable';
import { buildMcpServer } from '../../src/core/mcp/server';
import { getTimetable } from '../../src/core/services/timetable';
import type { DayNote, Timetable, TimetableClass, TimetableDay } from '../../src/core/types';
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
  source: 'syllabus',
  ...patch,
});

const day = (date: string, weekday: number, classes: TimetableClass[] = [], notes: DayNote[] = []): TimetableDay => ({
  date,
  weekday,
  notes,
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
    day('2026-10-21', 3, [], [{ kind: 'held', name: '創立記念日' }]),
  ],
  onDemand: [
    { courseId: 103, courseName: 'Online Japanese', url: 'u', term: '秋学期', kind: 'on-demand', alsoInClass: false },
  ],
  unknown: [{ courseId: 104, courseName: 'Mystery Course', url: 'u', reason: 'pending' }],
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
    expect(text).toContain('Tue 10/20 — no known classes'); // a course time is still unknown
    expect(text).toContain('Wed 10/21 — no known classes (Classes held: 創立記念日)');
    expect(text).toContain('On-demand: Online Japanese');
    expect(text).toContain('Online Japanese (course_id 103)');
    expect(text).toContain('Time unknown (not loaded yet, ask again to retry): Mystery Course (course_id 104).');
  });

  it('names a campus other than Waseda, and says when the day has classes plus a note', () => {
    const text = renderTimetable(
      timetable({
        from: '2026-10-12',
        to: '2026-10-12',
        days: [day('2026-10-12', 1, [klass({ campus: '所沢' })], [{ kind: 'held', name: 'スポーツの日' }])],
        onDemand: [],
        unknown: [],
      }),
    );
    expect(text).toContain('Timetable 2026-10-12.');
    expect(text).toContain('Mon 10/12 — (Classes held: スポーツの日)');
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

describe('renderTimetable: day notes', () => {
  const only = (days: TimetableDay[]) => {
    const [first, last] = [days[0]?.date ?? '', days.at(-1)?.date ?? ''];
    return renderTimetable(timetable({ from: first, to: last, days, onDemand: [], unknown: [] }));
  };

  it('words each note kind in English', () => {
    const text = only([
      day('2026-11-05', 4, [], [{ kind: 'closed', name: '臨時の休業日' }]),
      day('2026-10-20', 2, [klass({})], [{ kind: 'swap', weekday: 1 }]),
      day('2026-12-23', 3, [], [{ kind: 'winter-break' }]),
    ]);
    expect(text).toContain('Thu 11/05 — No classes: 臨時の休業日');
    expect(text).toContain('Tue 10/20 — (Follows the Monday schedule (振替))');
    expect(text).toContain('Wed 12/23 — No classes: winter break');
  });

  it('prints a run of break days once, and a single break day on its own', () => {
    const brk = (date: string, weekday: number) => day(date, weekday, [], [{ kind: 'term-break' }]);
    const text = only([
      day('2026-10-15', 4, [klass({})]),
      brk('2026-10-16', 5),
      brk('2026-10-17', 6),
      brk('2026-10-18', 7),
      day('2026-10-19', 1, [klass({})]),
      brk('2026-10-20', 2),
      day('2026-10-21', 3, [klass({})]),
    ]);
    expect(text).toContain('10/16–10/18: no classes (term break)');
    expect(text).not.toContain('Fri 10/16');
    expect(text).toContain('Tue 10/20 — No classes: term break');
    expect(text.match(/term break/g)).toHaveLength(2);
  });

  it('does not merge different breaks or a break day that has a note of its own', () => {
    const text = only([
      day('2026-12-21', 1, [klass({})]),
      day('2026-12-22', 2, [], [{ kind: 'winter-break' }]),
      day('2026-12-23', 3, [], [{ kind: 'winter-break' }]),
      day('2026-12-24', 4, [], [{ kind: 'term-break' }]),
      day('2026-12-25', 5, [], [{ kind: 'closed', name: '臨時の休業日' }]),
    ]);
    expect(text).toContain('12/22–12/23: no classes (winter break)');
    expect(text).toContain('Thu 12/24 — No classes: term break');
    expect(text).toContain('Fri 12/25 — No classes: 臨時の休業日');
  });
});

describe('renderTimetable: sources, hybrids and unknown courses', () => {
  it('marks user-set and Moodle-inferred times and leaves syllabus times unmarked', () => {
    const text = renderTimetable(
      timetable({
        from: '2026-10-19',
        to: '2026-10-19',
        days: [
          day('2026-10-19', 1, [
            klass({}),
            klass({ courseId: 2, courseName: 'Mine', start: '13:10', end: '14:50', periods: 'P3', source: 'user' }),
            klass({ courseId: 3, courseName: 'Seen', start: '15:05', end: '16:45', periods: 'P4', source: 'moodle' }),
          ]),
        ],
        onDemand: [],
        unknown: [],
      }),
    );
    expect(text).toContain('Strategic Marketing (P1–2, 11-502) course_id 101');
    expect(text).toContain('Mine (P3, 11-502) (set by user) course_id 2');
    expect(text).toContain('Seen (P4, 11-502) (from Moodle attendance) course_id 3');
  });

  const listed = (
    courseId: number,
    courseName: string,
    kind: 'on-demand' | 'no-fixed-time',
    alsoInClass: boolean,
  ): Timetable['onDemand'][number] => ({ courseId, courseName, url: 'u', term: '秋学期', kind, alsoInClass });

  it('lists hybrids apart from plain on-demand courses', () => {
    const text = renderTimetable(
      timetable({
        onDemand: [
          listed(103, 'Online Japanese', 'on-demand', false),
          listed(105, 'Hybrid Writing', 'on-demand', true),
          listed(106, 'Block Seminar', 'no-fixed-time', false),
        ],
        unknown: [],
      }),
    );
    expect(text).toContain('On-demand: Online Japanese (course_id 103).');
    expect(text).toContain('No weekly class (intensive or other): Block Seminar (course_id 106).');
    expect(text).toContain('On-demand (also meets in class): Hybrid Writing (course_id 105).');
  });

  it('labels each listed course by what it is: an intensive course that also meets is not "on-demand"', () => {
    const text = renderTimetable(
      timetable({
        onDemand: [
          listed(105, 'Hybrid Writing', 'on-demand', true),
          listed(107, 'Intensive Plus', 'no-fixed-time', true),
          listed(106, 'Block Seminar', 'no-fixed-time', false),
        ],
        unknown: [],
      }),
    );
    expect(text).toContain('Intensive (also meets in class): Intensive Plus (course_id 107).');
    expect(text).toContain('On-demand (also meets in class): Hybrid Writing (course_id 105).');
    expect(text).toContain('No weekly class (intensive or other): Block Seminar (course_id 106).');
    expect(text).not.toMatch(/On-demand[^:\n]*: [^\n]*Intensive Plus/);
    expect(text).not.toContain('On-demand:');
  });

  it('offers a retry only for courses not loaded yet; the others can be set with set_course_schedule', () => {
    const ref = (courseId: number, reason: Timetable['unknown'][number]['reason']) => ({
      courseId,
      courseName: `Course ${courseId}`,
      url: 'u',
      reason,
    });
    const unknown = [ref(1, 'pending'), ref(2, 'not-found'), ref(3, 'unparsed'), ref(4, 'lookup-off')];
    const mixed = renderTimetable(timetable({ onDemand: [], unknown }));
    expect(mixed).toContain('Time unknown (not loaded yet, ask again to retry): Course 1 (course_id 1).');
    expect(mixed).toContain(
      'Time unknown (can be set with set_course_schedule once the user says it): Course 2 (course_id 2); Course 3 (course_id 3); Course 4 (course_id 4).',
    );
    const settable = renderTimetable(timetable({ onDemand: [], unknown: [ref(2, 'not-found')] }));
    expect(settable).not.toContain('retry');
    expect(settable).toContain('set_course_schedule');
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

  it("describes the scope as the user's courses (confirmed or suggested)", async () => {
    const client = await connect(['moodle:read']);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'get_timetable');
    expect(tool?.description).toContain("the user's courses (confirmed, or the automatic suggestion)");
    expect(tool?.description).not.toContain('confirmed courses only');
  });

  it('is mentioned in the server instructions', async () => {
    const client = await connect(['moodle:read']);
    expect(client.getInstructions()).toMatch(/get_timetable/);
  });
});
