import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import { getDueItems } from '../../src/core/services/due';
import { getTimetableDays } from '../../src/core/services/timetable';
import type { DueList, TimetableDay } from '../../src/core/types';
import { buildFeed } from '../../src/worker/calendar/feed';

vi.mock('../../src/core/services/due', () => ({ getDueItems: vi.fn() }));
vi.mock('../../src/core/services/timetable', () => ({ getTimetableDays: vi.fn() }));

const ctxFor = (publicUrl: string) => ({ publicUrl }) as unknown as ServiceContext;

const dueList = (): DueList =>
  ({
    items: [
      {
        kind: 'assign',
        courseId: 11,
        courseName: 'Strategic Marketing',
        cmid: 501,
        name: 'Report 1',
        dueAt: '2026-10-16T23:59:00+09:00',
        midnightDue: false,
        overdue: false,
        closed: false,
        url: '',
        source: 'calendar',
        evidence: null,
        sourceUrl: null,
        submission: null,
      },
    ],
  }) as unknown as DueList;

const dayOf = (date: string): TimetableDay =>
  ({
    date,
    weekday: 1,
    notes: [],
    classes:
      date === '2026-10-15' || date === '2026-11-05'
        ? [
            {
              courseId: 11,
              courseName: 'Strategic Marketing',
              start: '08:50',
              end: '10:30',
              periods: 'P1',
              periodFrom: 1,
              periodTo: 1,
              night: false,
              classroom: null,
              campus: null,
              url: '',
              source: 'syllabus',
            },
          ]
        : [],
  }) as unknown as TimetableDay;

beforeEach(() => {
  vi.mocked(getDueItems).mockReset();
  vi.mocked(getTimetableDays).mockReset();
  vi.mocked(getDueItems).mockResolvedValue(dueList());
  vi.mocked(getTimetableDays).mockImplementation(async (_ctx, dates) => dates.map(dayOf));
});

describe('buildFeed', () => {
  it('asks for -7..+60 days of due items (stored snapshots only) and 28 days of classes at once', async () => {
    const ctx = ctxFor('https://wasemoodle.example.com');
    const ics = await buildFeed(ctx, Date.UTC(2026, 9, 15, 3, 0, 0));

    expect(getDueItems).toHaveBeenCalledWith(ctx, { daysAhead: 60, overdueDays: 7, sweep: 'cached' });
    expect(getTimetableDays).toHaveBeenCalledTimes(1);
    const dates = vi.mocked(getTimetableDays).mock.calls[0]?.[1] ?? [];
    expect(dates).toHaveLength(28);
    expect(dates[0]).toBe('2026-10-15');
    expect(dates[27]).toBe('2026-11-11');
    expect(ics).toContain('UID:wmm-due-501@wasemoodle.example.com');
    expect(ics).toContain('UID:wmm-class-11-2026-10-15-1-1@wasemoodle.example.com');
    expect(ics).toContain('UID:wmm-class-11-2026-11-05-1-1@wasemoodle.example.com');
  });

  it('starts the timetable on the JST date, not the UTC one', async () => {
    await buildFeed(ctxFor(''), Date.UTC(2026, 9, 15, 16, 0, 0)); // 01:00 on 10-16 in Tokyo
    expect(vi.mocked(getTimetableDays).mock.calls[0]?.[1][0]).toBe('2026-10-16');
  });

  it('falls back to a reserved host when the public URL is missing', async () => {
    expect(await buildFeed(ctxFor(''), Date.UTC(2026, 9, 15))).toContain('@wasemoodle.invalid');
  });

  it('fails as a whole when a service fails, so no partial feed is cached', async () => {
    vi.mocked(getTimetableDays).mockRejectedValueOnce(new Error('boom'));
    await expect(buildFeed(ctxFor('https://x.example'), Date.UTC(2026, 9, 15))).rejects.toThrow('boom');
  });
});
