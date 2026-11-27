import { describe, expect, it } from 'vitest';
import { getActivity } from '../../src/core/services/activity';
import { parseSessionTime } from '../../src/core/services/activity/attendance-text';
import { parseAttendancePage } from '../../src/core/services/activity/attendance-web';
import type { AttendanceDetail } from '../../src/core/types';
import { makeFakeContext } from '../helpers/fake-context-be3';
import { fixture, makeWebApi } from './web-channel';

const cm = { cmid: 7012, courseId: 99101, modname: 'attendance', instance: 7012, name: '出席記録' };
const info = {
  courseName: '総合日本語３Ｘ',
  url: 'https://wsdmoodle.waseda.jp/mod/attendance/view.php?id=7012',
  lang: 'ja',
};

describe('parseSessionTime on the activity page', () => {
  it('reads the Japanese slash date and the English plugin date with a 12-hour clock', () => {
    expect(parseSessionTime('2026/10/09 (金) 1:00PM - 2:40PM')).toBe('2026-10-09T13:00:00+09:00');
    expect(parseSessionTime('2026/10/16 (金) 10:40AM - 12:20PM')).toBe('2026-10-16T10:40:00+09:00');
    expect(parseSessionTime('Fri 2 Oct 2026 8:50AM - 10:30AM')).toBe('2026-10-02T08:50:00+09:00');
  });
});

describe('parseAttendancePage', () => {
  it('reads the Japanese page by its table structure: sessions newest first, the three summary rows', () => {
    const a = parseAttendancePage(fixture('attendance-view-ja.html'), cm, info);
    expect(a).toMatchObject({
      type: 'attendance',
      cmid: 7012,
      courseId: 99101,
      complete: true,
      summary: {
        takenSessions: 2,
        points: '3 / 4',
        percentage: '75.0%',
        totalSessions: null,
        maxPossiblePoints: null,
        maxPossiblePercentage: null,
      },
    });
    expect(a.description).toContain('授業の出欠をここに記録します。');
    expect(a.description).not.toContain('<p');
    expect(a.sessions.map((s) => [s.at, s.status, s.remarks])).toEqual([
      ['2026-10-16T10:40:00+09:00', null, null],
      ['2026-10-09T13:00:00+09:00', '遅刻', '遅延あり'],
      ['2026-10-02T08:50:00+09:00', '出席', null],
    ]);
    expect(a.sessions[0]).toMatchObject({ time: '2026/10/16 (金) 10:40AM - 12:20PM', group: '対面授業' });
  });

  it('reads the English page with the "all sessions" summary rows and status acronyms', () => {
    const a = parseAttendancePage(fixture('attendance-view-en.html'), cm, { ...info, lang: 'en' });
    expect(a.summary).toEqual({
      takenSessions: 2,
      points: '3 / 4',
      percentage: '75.0%',
      totalSessions: 15,
      maxPossiblePoints: '29 / 30',
      maxPossiblePercentage: '96.7%',
    });
    expect(a.sessions.map((s) => [s.acronym, s.status])).toEqual([
      [null, null],
      ['L', 'Late'],
      ['P', 'Present'],
    ]);
    expect(a.sessions[2]?.at).toBe('2026-10-02T08:50:00+09:00');
  });

  it('gives an empty summary and no sessions for a page without the tables', () => {
    const a = parseAttendancePage('<div id="region-main"><p>Nothing yet.</p></div>', cm, info);
    expect(a.sessions).toEqual([]);
    expect(a.summary.takenSessions).toBeNull();
  });
});

describe('getActivity attendance on the web channel', () => {
  it('reads the activity page instead of the mobile template', async () => {
    const api = makeWebApi({
      pages: { '/mod/attendance/view.php?id=7012': fixture('attendance-view-en.html') },
      handlers: {
        core_course_get_course_module: {
          cm: { id: 7012, course: 99101, modname: 'attendance', instance: 7012, name: 'Attendance' },
        },
      },
    });
    const { ctx } = makeFakeContext({});
    const a = (await getActivity({ ...ctx, moodle: async () => api }, 7012)) as AttendanceDetail;
    expect(a.type).toBe('attendance');
    expect(a.summary.totalSessions).toBe(15);
    expect(api.calls.map((c) => c.fn)).not.toContain('tool_mobile_get_content');
    expect(api.pageCalls).toEqual(['GET /mod/attendance/view.php?id=7012']);
  });
});
