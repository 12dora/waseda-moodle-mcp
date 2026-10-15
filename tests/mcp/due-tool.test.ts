import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import { courseTools } from '../../src/core/mcp/tools/courses';
import { getDueItems } from '../../src/core/services/due';
import type { DueItem, DueList } from '../../src/core/types';

vi.mock('../../src/core/services/due', () => ({ getDueItems: vi.fn() }));

const tool = courseTools.find((t) => t.name === 'get_due_items');

const undated = (n: number): DueItem => ({
  kind: 'other',
  courseId: 101,
  courseName: 'Strategic Marketing',
  cmid: 100 + n,
  name: `Undated ${n}`,
  opensAt: null,
  dueAt: null,
  midnightDue: false,
  overdue: false,
  closed: false,
  notOpenYet: false,
  url: `https://moodle.example.edu/mod/page/view.php?id=${100 + n}`,
  action: null,
  source: 'activity',
  evidence: null,
  sourceUrl: null,
  isNew: false,
  submission: null,
});

const list: DueList = {
  generatedAt: '2026-10-14T12:00:00+09:00',
  windowFrom: '2026-09-30T12:00:00+09:00',
  windowTo: '2026-10-28T12:00:00+09:00',
  items: Array.from({ length: 8 }, (_, i) => undated(i)),
  scope: { mode: 'mine', courseIds: [101], otherCount: 0 },
  otherCourses: [],
  sweep: { checked: 1, stale: 0, checkedAt: null },
  truncated: false,
};

const ctxOf = (mode: 'worker' | 'stdio') => ({ mode }) as unknown as ServiceContext;

async function run(mode: 'worker' | 'stdio', args: Record<string, unknown>) {
  if (!tool) throw new Error('get_due_items is not registered');
  return tool.run(ctxOf(mode), tool.input.parse(args) as never);
}

describe('get_due_items tool', () => {
  beforeEach(() => {
    vi.mocked(getDueItems).mockReset();
    vi.mocked(getDueItems).mockResolvedValue(list);
  });

  it('is titled Assignments & deadlines', () => {
    expect(tool?.title).toBe('Assignments & deadlines');
    expect(tool?.description).toContain('group_by=course');
    expect(tool?.description).toContain('struck through');
    expect(tool?.description).not.toContain('listed apart under Submitted');
  });

  it('accepts kinds and include_submitted, and rejects unknown kinds or an empty list', () => {
    expect(tool?.input.safeParse({ kinds: ['assign', 'quiz'], include_submitted: false }).success).toBe(true);
    expect(tool?.input.safeParse({ kinds: ['homework'] }).success).toBe(false);
    expect(tool?.input.safeParse({ kinds: [] }).success).toBe(false);
    expect(tool?.input.safeParse({ include_submitted: 'no' }).success).toBe(false);
  });

  it('accepts group_by date or course and rejects other values', () => {
    expect(tool?.input.safeParse({ group_by: 'date' }).success).toBe(true);
    expect(tool?.input.safeParse({ group_by: 'course' }).success).toBe(true);
    expect(tool?.input.safeParse({}).success).toBe(true);
    expect(tool?.input.safeParse({ group_by: 'week' }).success).toBe(false);
  });

  it('passes the filters to the service', async () => {
    await run('worker', { days_ahead: 7, course_id: 101, kinds: ['assign'], include_submitted: false });
    expect(getDueItems).toHaveBeenCalledWith(expect.anything(), {
      daysAhead: 7,
      overdueDays: undefined,
      courseId: 101,
      kinds: ['assign'],
      includeSubmitted: false,
    });
  });

  it('passes group_by to the renderer and not to the service', async () => {
    const out = await run('worker', { group_by: 'course' });
    expect(getDueItems).toHaveBeenCalledWith(expect.anything(), {
      daysAhead: undefined,
      overdueDays: undefined,
      courseId: undefined,
      kinds: undefined,
      includeSubmitted: undefined,
    });
    expect(out.text).toContain('(course_id 101) — overdue 0 · to do 8 · draft 0 · submitted 0');
    expect(out.text).toContain('## Strategic Marketing');
    expect(out.text).not.toContain('## No deadline');
    expect(out.data).toBe(list);
  });

  it('echoes the filters in the text and returns the service list as structuredContent', async () => {
    const out = await run('worker', { kinds: ['other'], include_submitted: false });
    expect(out.text).toContain('Filtered: only kinds: other; submitted items hidden.');
    expect(out.data).toBe(list);
  });

  it('words the undated overflow by mode: console pointer hosted, none in stdio', async () => {
    const hosted = (await run('worker', {})).text;
    expect(hosted).toContain('Assignments & deadlines. Times are JST');
    expect(hosted).not.toContain('Due items.');
    expect(hosted).toContain("see the console's Assignments & deadlines page");
    const stdio = (await run('stdio', {})).text;
    expect(stdio).toContain('all are in structuredContent');
    expect(stdio.toLowerCase()).not.toContain('console');
  });
});
