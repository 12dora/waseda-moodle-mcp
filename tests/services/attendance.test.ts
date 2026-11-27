import { describe, expect, it } from 'vitest';
import { getActivity } from '../../src/core/services/activity';
import { MAX_ATTENDANCE_HTML, mapAttendance } from '../../src/core/services/activity/attendance';
import { parseSessionTime } from '../../src/core/services/activity/attendance-text';
import type { AttendanceDetail } from '../../src/core/types';
import { ATTENDANCE_SUMMARY_ONLY, ATTENDANCE_WITH_SESSIONS, attendanceMobileHtml } from '../fixtures/attendance/mobile';
import { FAKE_BASE_URL, makeFakeContext } from '../helpers/fake-context-be3';

const cm = { cmid: 7012, courseId: 9001, modname: 'attendance' as const, instance: 8001, name: 'Class attendance' };
const info = {
  courseName: 'Corporate Finance Basics',
  url: `${FAKE_BASE_URL}/mod/attendance/view.php?id=7012`,
  lang: 'en',
};

const cmOf = (id: number) => ({
  cm: { id, course: 9001, modname: 'attendance', instance: 8001, name: 'Class attendance' },
  warnings: [],
});

describe('parseSessionTime', () => {
  it('reads the attendance plugin format, English long form and Japanese', () => {
    expect(parseSessionTime('Fri 16 Oct 2026 01:00PM - 02:40PM')).toBe('2026-10-16T13:00:00+09:00');
    expect(parseSessionTime('Monday, 13 October 2026, 1:00 PM')).toBe('2026-10-13T13:00:00+09:00');
    expect(parseSessionTime('2026年 10月 16日(金曜日) 13:00')).toBe('2026-10-16T13:00:00+09:00');
    expect(parseSessionTime('October 13, 2026, 12:00 AM')).toBe('2026-10-13T00:00:00+09:00');
    expect(parseSessionTime('not a date')).toBeNull();
  });
});

describe('mapAttendance', () => {
  it('reads the summary from plugin keys, not labels, and the intro as markdown', () => {
    const a = mapAttendance(ATTENDANCE_SUMMARY_ONLY, cm, info);
    expect(a).toMatchObject({
      type: 'attendance',
      cmid: 7012,
      instanceId: 8001,
      courseId: 9001,
      name: 'Class attendance',
      summary: {
        takenSessions: 6,
        points: '12 / 18',
        percentage: '66.7%',
        totalSessions: 15,
        maxPossiblePoints: '24 / 30',
        maxPossiblePercentage: '80.0%',
      },
      sessions: [],
      complete: true,
    });
    expect(a.description).toContain('Please come to class on time.');
    expect(a.description).not.toContain('<p>');
  });

  it('keeps empty cells as null and ignores the all-sessions percentage row', () => {
    const html = attendanceMobileHtml({
      summary: {
        taken: '',
        points: '',
        percentage: '',
        total: '0',
        maxPoints: '0 / 0',
        maxPercentage: '0.0%',
      },
    });
    const a = mapAttendance(html, cm, info);
    expect(a.summary).toMatchObject({
      takenSessions: null,
      points: null,
      percentage: null,
      totalSessions: 0,
      maxPossiblePoints: '0 / 0',
      maxPossiblePercentage: '0.0%',
    });
  });

  it('parses session ion-items (newest first) and skips the summary grid and flash messages', () => {
    const a = mapAttendance(ATTENDANCE_WITH_SESSIONS, cm, info);
    expect(a.sessions).toHaveLength(3);
    expect(a.sessions[0]).toMatchObject({
      at: '2026-10-16T13:00:00+09:00',
      status: 'Late',
      acronym: null,
      remarks: null,
    });
    expect(a.sessions[1]).toMatchObject({
      at: '2026-10-09T13:00:00+09:00',
      group: 'Group A',
      acronym: 'P',
      status: 'Present',
    });
    expect(a.sessions[2]).toMatchObject({
      at: '2026-10-02T13:00:00+09:00',
      status: 'Absent',
      remarks: 'sick',
    });

    const withMsg = mapAttendance(attendanceMobileHtml({ message: 'attendancesuccess', sessions: [] }), cm, info);
    expect(withMsg.sessions).toEqual([]);
    expect(withMsg.summary.takenSessions).toBe(6);
  });

  it('caps sessions at 20 most recent and treats empty HTML as an empty summary', () => {
    const sessions = Array.from({ length: 21 }, (_, i) => ({
      time: `Fri ${String(i + 1).padStart(2, '0')} Oct 2026 01:00PM - 02:40PM`,
      status: 'Present',
    }));
    const a = mapAttendance(attendanceMobileHtml({ sessions }), cm, info);
    expect(a.sessions).toHaveLength(20);
    expect(a.sessions[0]?.time).toContain('21 Oct');
    expect(a.sessions[19]?.time).toContain('02 Oct');

    const empty = mapAttendance('', cm, info);
    expect(empty.summary.takenSessions).toBeNull();
    expect(empty.sessions).toEqual([]);
    expect(empty.description).toBe('');
    expect(empty.complete).toBe(true);
  });

  it('reads the summary and newest sessions when the template exceeds the HTML cap', () => {
    const sessions = Array.from({ length: 21 }, (_, i) => ({
      time: `Fri ${String(i + 1).padStart(2, '0')} Oct 2026 01:00PM - 02:40PM`,
      status: 'Present',
      remarks: i === 20 ? 'r'.repeat(400) : undefined,
    }));
    const html = attendanceMobileHtml({
      intro: `<p>${'x'.repeat(MAX_ATTENDANCE_HTML)}</p>`,
      sessions,
    });
    expect(html.length).toBeGreaterThan(MAX_ATTENDANCE_HTML);
    const a = mapAttendance(html, cm, info);
    expect(a.complete).toBe(false);
    expect(a.summary).toMatchObject({
      takenSessions: 6,
      points: '12 / 18',
      percentage: '66.7%',
      totalSessions: 15,
      maxPossiblePoints: '24 / 30',
      maxPossiblePercentage: '80.0%',
    });
    expect(a.sessions).toHaveLength(20);
    expect(a.sessions[0]?.time).toContain('21 Oct');
    expect(a.sessions[19]?.time).toContain('02 Oct');
    expect(a.sessions.some((s) => s.time.includes('01 Oct'))).toBe(false);
    expect(a.sessions[0]?.remarks?.length).toBeLessThanOrEqual(200);
  });
});

describe('getActivity attendance', () => {
  it('loads via tool_mobile_get_content with cmid and courseid', async () => {
    const { ctx, calls } = makeFakeContext({
      core_course_get_course_module: cmOf(7012),
      tool_mobile_get_content: { templates: [{ id: 'main', html: ATTENDANCE_WITH_SESSIONS }] },
    });
    const a = (await getActivity(ctx, 7012)) as AttendanceDetail;
    expect(a.type).toBe('attendance');
    expect(a.summary.percentage).toBe('66.7%');
    expect(a.sessions).toHaveLength(3);
    expect(a.url).toBe(`${FAKE_BASE_URL}/mod/attendance/view.php?id=7012`);
    expect(calls.filter((c) => c.fn === 'tool_mobile_get_content')).toEqual([
      {
        fn: 'tool_mobile_get_content',
        params: {
          component: 'mod_attendance',
          method: 'mobile_view_activity',
          args: [
            { name: 'cmid', value: '7012' },
            { name: 'courseid', value: '9001' },
          ],
        },
      },
    ]);
  });
});
