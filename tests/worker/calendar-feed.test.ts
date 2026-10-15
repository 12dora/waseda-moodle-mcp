import { describe, expect, it } from 'vitest';
import type { DueItem, TimetableClass, TimetableDay } from '../../src/core/types';
import { type FeedData, reconnectFeed, renderFeed } from '../../src/worker/calendar/feed';

const NOW = Date.UTC(2026, 9, 15, 3, 0, 0);
const HOST = 'wasemoodle.example.com';

const due = (over: Partial<DueItem> = {}): DueItem => ({
  kind: 'assign',
  courseId: 11,
  courseName: 'Strategic Marketing',
  cmid: 501,
  name: 'Report 1',
  opensAt: null,
  dueAt: '2026-10-16T23:59:00+09:00',
  midnightDue: false,
  overdue: false,
  closed: false,
  notOpenYet: false,
  url: 'https://wsdmoodle.waseda.jp/mod/assign/view.php?id=501',
  action: 'Add submission',
  source: 'calendar',
  evidence: null,
  sourceUrl: null,
  isNew: false,
  submission: null,
  ...over,
});

const klass = (over: Partial<TimetableClass> = {}): TimetableClass => ({
  courseId: 11,
  courseName: 'Strategic Marketing',
  start: '08:50',
  end: '12:20',
  periods: 'P1–2',
  periodFrom: 1,
  periodTo: 2,
  night: false,
  classroom: '11号館 502',
  campus: '早稲田',
  url: 'https://wsdmoodle.waseda.jp/course/view.php?id=11',
  source: 'syllabus',
  ...over,
});

type Status = NonNullable<DueItem['submission']>['status'];

const progress = (status: Status, note: string | null = null): DueItem['submission'] => ({
  status,
  canContinue: true,
  submittedAt: null,
  graded: false,
  note,
});

const day = (date: string, classes: TimetableClass[]): TimetableDay => ({
  date,
  weekday: 1,
  notes: [],
  classes,
});

function render(items: DueItem[], days: TimetableDay[] = []): string {
  const data: FeedData = { due: { items }, days };
  return renderFeed(data, { host: HOST, now: NOW }).replace(/\r\n /g, '');
}

/** The VEVENT blocks of a rendered feed. */
const events = (ics: string): string[] => ics.split('BEGIN:VEVENT\r\n').slice(1);
const uids = (ics: string): string[] => events(ics).map((e) => /UID:(.*)\r\n/.exec(e)?.[1] ?? '');

describe('due events', () => {
  it('renders an outstanding item as a zero-duration, free event at its deadline', () => {
    const [ev] = events(render([due()]));
    expect(ev).toContain(`UID:wmm-due-501@${HOST}\r\n`);
    expect(ev).toContain('DTSTART:20261016T145900Z\r\n');
    expect(ev).not.toContain('DTEND');
    expect(ev).toContain('SUMMARY:Due: Report 1 (Strategic Marketing)\r\n');
    expect(ev).toContain('URL:https://wsdmoodle.waseda.jp/mod/assign/view.php?id=501\r\n');
    expect(ev).toContain('STATUS:CONFIRMED\r\n');
    expect(ev).toContain('TRANSP:TRANSPARENT\r\n');
  });

  it('leaves out submitted, closed and undated items', () => {
    const ics = render([
      due({ cmid: 1, submission: progress('submitted') }),
      due({ cmid: 2, closed: true, overdue: true }),
      due({ cmid: 3, dueAt: null, opensAt: '2026-10-20T09:00:00+09:00' }),
      due({ cmid: 4 }),
    ]);
    expect(uids(ics)).toEqual([`wmm-due-4@${HOST}`]);
  });

  it('flags drafts, attempts in progress and reopened work in the SUMMARY suffix', () => {
    const ics = render([
      due({ cmid: 1, submission: progress('draft', 'submit button not pressed') }),
      due({ cmid: 2, kind: 'quiz', submission: progress('in-progress') }),
      due({ cmid: 3, submission: progress('reopened') }),
    ]);
    expect(ics).toContain('SUMMARY:Due: Report 1 (Strategic Marketing) [draft saved\\, not submitted]');
    expect(ics).toContain('[attempt in progress\\, not submitted]');
    expect(ics).toContain('[reopened for resubmission]');
    expect(ics).toContain('Status: draft saved\\, not submitted.\\nsubmit button not pressed');
  });

  it('shows a 00:00 deadline at 23:59 of the previous day and explains it in the DESCRIPTION', () => {
    const [ev] = events(render([due({ dueAt: '2026-10-17T00:00:00+09:00', midnightDue: true })]));
    expect(ev).toContain('DTSTART:20261016T145900Z\r\n');
    expect(ev).toContain('Due: 2026-10-16 Fri 24:00 JST');
    expect(ev).toContain("Moodle's deadline is 2026-10-17 Sat 00:00 JST");
    expect(ev).toContain('23:59 of the previous day');
  });

  it('marks dates found in course text as TENTATIVE and keeps the evidence', () => {
    const [ev] = events(
      render([
        due({
          cmid: 700,
          source: 'text',
          evidence: 'submit by 10/20, noon',
          sourceUrl: 'https://wsdmoodle.waseda.jp/mod/page/view.php?id=700',
        }),
      ]),
    );
    expect(ev).toContain('STATUS:TENTATIVE\r\n');
    expect(ev).toContain('Text: submit by 10/20\\, noon');
    expect(ev).toContain('Found at: https://wsdmoodle.waseda.jp/mod/page/view.php?id=700');
    expect(ev).not.toContain(`UID:wmm-due-700@${HOST}`);
  });

  it('gives items without a cmid a stable hash UID, whatever the list order, that follows the due date', () => {
    const a = uids(render([due({ cmid: null })]))[0];
    expect(a).toMatch(new RegExp(`^wmm-due-[0-9a-z]+@${HOST}$`));
    expect(uids(render([due({ cmid: null }), due({ cmid: null, name: 'Report 2' })]))[0]).toBe(a);
    expect(uids(render([due({ cmid: null, name: 'Report 2' }), due({ cmid: null })]))[1]).toBe(a);
    expect(uids(render([due({ cmid: null, name: 'Report 2' })]))[0]).not.toBe(a);
    expect(uids(render([due({ cmid: null, dueAt: '2026-10-18T10:00:00+09:00' })]))[0]).not.toBe(a);
  });

  it('keeps same-named events without a cmid apart by their due date, with no order-dependent suffix', () => {
    const week1 = due({ cmid: null, name: 'Weekly quiz', dueAt: '2026-10-16T23:59:00+09:00' });
    const week2 = due({ cmid: null, name: 'Weekly quiz', dueAt: '2026-10-23T23:59:00+09:00' });
    const [a, b] = uids(render([week1, week2]));
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/-2@/);
    expect(b).not.toMatch(/-2@/);
    expect(uids(render([week2, week1]))).toEqual([b, a]);
  });

  it('keeps UIDs unique when two items share a cmid', () => {
    const ics = render([due({ cmid: 9 }), due({ cmid: 9, name: 'Same module, other deadline' })]);
    expect(uids(ics)).toEqual([`wmm-due-9@${HOST}`, `wmm-due-9-2@${HOST}`]);
  });
});

describe('class events', () => {
  it('renders each class with UTC times, room in LOCATION and a stable UID', () => {
    const ics = render([], [day('2026-10-19', [klass()])]);
    const [ev] = events(ics);
    expect(ev).toContain(`UID:wmm-class-11-2026-10-19-1-2@${HOST}\r\n`);
    expect(ev).toContain('DTSTART:20261018T235000Z\r\n');
    expect(ev).toContain('DTEND:20261019T032000Z\r\n');
    expect(ev).toContain('SUMMARY:Strategic Marketing\r\n');
    expect(ev).toContain('LOCATION:11号館 502\\, 早稲田\r\n');
    expect(ev).toContain('DESCRIPTION:P1–2 (08:50-12:20 JST)\r\n');
    expect(ev).toContain('TRANSP:OPAQUE\r\n');
  });

  it('uses the evening clock as given, omits an unknown room and notes the source of inferred times', () => {
    const night = klass({
      courseId: 22,
      start: '18:30',
      end: '20:10',
      periods: 'P6',
      periodFrom: 6,
      periodTo: 6,
      night: true,
      classroom: null,
      campus: null,
      source: 'moodle',
    });
    const [ev] = events(render([], [day('2026-10-20', [night])]));
    expect(ev).toContain('DTSTART:20261020T093000Z\r\n');
    expect(ev).toContain('DTEND:20261020T111000Z\r\n');
    expect(ev).not.toContain('LOCATION');
    expect(ev).toContain('Time inferred from the Moodle attendance sessions.');
  });

  it('gives the same course on different days and periods different UIDs', () => {
    const second = klass({ start: '13:10', end: '14:50', periods: 'P3', periodFrom: 3, periodTo: 3 });
    const ics = render([], [day('2026-10-19', [klass(), second]), day('2026-10-26', [klass()])]);
    expect(uids(ics)).toEqual([
      `wmm-class-11-2026-10-19-1-2@${HOST}`,
      `wmm-class-11-2026-10-19-3-3@${HOST}`,
      `wmm-class-11-2026-10-26-1-2@${HOST}`,
    ]);
  });

  it('tells slots apart by their last period and by the night clock', () => {
    const p6 = klass({ periodFrom: 6, periodTo: 6, start: '18:30', end: '20:10', night: true });
    const p6to7 = klass({ periodFrom: 6, periodTo: 7, start: '18:30', end: '22:00', night: true });
    const dayP6 = klass({ periodFrom: 6, periodTo: 6, start: '16:55', end: '18:35', night: false });
    const ics = render([], [day('2026-10-21', [p6, p6to7, dayP6])]);
    expect(uids(ics)).toEqual([
      `wmm-class-11-2026-10-21-6-6-n@${HOST}`,
      `wmm-class-11-2026-10-21-6-7-n@${HOST}`,
      `wmm-class-11-2026-10-21-6-6@${HOST}`,
    ]);
  });

  it('drops an exact duplicate slot (the same course listed twice in one day)', () => {
    const ics = render([], [day('2026-10-19', [klass(), klass({ classroom: 'elsewhere' })])]);
    expect(uids(ics)).toEqual([`wmm-class-11-2026-10-19-1-2@${HOST}`]);
  });

  it('merges several days and puts due items before classes', () => {
    const data: FeedData = {
      due: { items: [due()] },
      days: [day('2026-10-19', [klass()]), day('2026-11-02', [klass()])],
    };
    const ics = renderFeed(data, { host: HOST, now: NOW });
    expect(uids(ics.replace(/\r\n /g, ''))).toEqual([
      `wmm-due-501@${HOST}`,
      `wmm-class-11-2026-10-19-1-2@${HOST}`,
      `wmm-class-11-2026-11-02-1-2@${HOST}`,
    ]);
  });
});

describe('document', () => {
  it('is a valid empty calendar when there is nothing to show', () => {
    const ics = render([]);
    expect(events(ics)).toEqual([]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('stamps every event with the generation time', () => {
    const ics = render([due()], [day('2026-10-19', [klass()])]);
    expect(ics.match(/DTSTAMP:20261015T030000Z/g)).toHaveLength(2);
  });
});

describe('reconnectFeed', () => {
  const notice = reconnectFeed({ publicUrl: 'https://wasemoodle.example.com', now: NOW }).replace(/\r\n /g, '');

  it('is a valid calendar with a single all-day event today pointing at the console', () => {
    expect(notice.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(notice.endsWith('END:VCALENDAR\r\n')).toBe(true);
    const evs = events(notice);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toContain('DTSTART;VALUE=DATE:20261015\r\n');
    expect(evs[0]).toContain('DTEND;VALUE=DATE:20261016\r\n');
    expect(evs[0]).toContain('SUMMARY:Waseda Moodle: reconnect your account\r\n');
    expect(evs[0]).toContain('URL:https://wasemoodle.example.com\r\n');
    expect(evs[0]).toMatch(/DESCRIPTION:.*https:\/\/wasemoodle\.example\.com/);
    expect(uids(notice)).toEqual(['wmm-reconnect@wasemoodle.example.com']);
  });

  it('dates the event by the JST day and omits the URL when no PUBLIC_URL is set', () => {
    const late = reconnectFeed({ publicUrl: '', now: Date.UTC(2026, 9, 15, 16, 0, 0) }); // 01:00 on 10-16 in Tokyo
    expect(late).toContain('DTSTART;VALUE=DATE:20261016\r\n');
    expect(late).not.toContain('URL:');
  });
});
