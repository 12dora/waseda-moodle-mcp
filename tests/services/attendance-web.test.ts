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
      complete: false, // one month only
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
    expect(a.sessions.map((s) => s.points)).toEqual(['? / 2', '2 / 2', '2 / 2']);
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
    expect(a.complete).toBe(true);
  });

  it('gives an empty summary and no sessions for a page without the tables', () => {
    const a = parseAttendancePage('<div id="region-main"><p>Nothing yet.</p></div>', cm, info);
    expect(a.sessions).toEqual([]);
    expect(a.summary.takenSessions).toBeNull();
    expect(a.complete).toBe(false);
  });
});

const VIEW = '/mod/attendance/view.php?id=7012';
const ALL = `${VIEW}&view=5`;
const MONTHS = `${VIEW}&view=3`;
const monthPage = fixture('attendance-view-ja.html');
const allPage = fixture('attendance-view-en.html');

async function read(pages: Record<string, string>) {
  const api = makeWebApi({
    pages,
    handlers: {
      core_course_get_course_module: {
        cm: { id: 7012, course: 99101, modname: 'attendance', instance: 7012, name: 'Attendance' },
      },
    },
  });
  const { ctx } = makeFakeContext({});
  const a = (await getActivity({ ...ctx, moodle: async () => api }, 7012)) as AttendanceDetail;
  return { a, api };
}

describe('getActivity attendance on the web channel', () => {
  it('reads all sessions of the term, then restores the view the user had (two further requests)', async () => {
    const { a, api } = await read({ [VIEW]: monthPage, [ALL]: allPage, [MONTHS]: monthPage });
    expect(a.type).toBe('attendance');
    expect(a.summary).toMatchObject({ takenSessions: 2, totalSessions: 15, percentage: '75.0%' });
    expect(a.sessions[2]).toMatchObject({ status: 'Present', points: '2 / 2' });
    expect(a.complete).toBe(true);
    expect(api.calls.map((c) => c.fn)).not.toContain('tool_mobile_get_content');
    expect(api.pageCalls).toEqual([`GET ${VIEW}`, `GET ${ALL}`, `GET ${MONTHS}`]);
  });

  it('restores whichever view was active: the one the page does not link to', async () => {
    const weeks = monthPage
      .replace('<span class="attcurbtn">月</span>', `<span class="attbtn"><a href="${MONTHS}">月</a></span>`)
      .replace(/<span class="attbtn"><a href="[^"]*view=2">週<\/a><\/span>/, '<span class="attcurbtn">週</span>');
    const { api } = await read({ [VIEW]: weeks, [ALL]: allPage, [`${VIEW}&view=2`]: weeks });
    expect(api.pageCalls).toEqual([`GET ${VIEW}`, `GET ${ALL}`, `GET ${VIEW}&view=2`]);
  });

  it('needs one request when the user already views all sessions', async () => {
    const { a, api } = await read({ [VIEW]: allPage });
    expect(a.complete).toBe(true);
    expect(api.pageCalls).toEqual([`GET ${VIEW}`]);
  });

  it('keeps the whole term when the view cannot be restored', async () => {
    const { a, api } = await read({ [VIEW]: monthPage, [ALL]: allPage });
    expect(a.summary.totalSessions).toBe(15);
    expect(a.complete).toBe(true);
    expect(api.pageCalls).toEqual([`GET ${VIEW}`, `GET ${ALL}`, `GET ${MONTHS}`]);
  });

  it('shows the current period as incomplete when all sessions cannot be read, and still restores', async () => {
    const { a, api } = await read({ [VIEW]: monthPage, [MONTHS]: monthPage });
    expect(a.summary).toMatchObject({ takenSessions: 2, totalSessions: null });
    expect(a.sessions).toHaveLength(3);
    expect(a.complete).toBe(false);
    expect(api.pageCalls).toEqual([`GET ${VIEW}`, `GET ${ALL}`, `GET ${MONTHS}`]);
  });

  it('leaves the view alone when the page does not tell which one is active', async () => {
    const bare = monthPage.replace(/class="viewcontrols /, 'class="');
    const { a, api } = await read({ [VIEW]: bare, [ALL]: allPage });
    expect(a.complete).toBe(false);
    expect(api.pageCalls).toEqual([`GET ${VIEW}`]);
  });

  it('lists every session of a long term, not only the newest twenty', async () => {
    const row = /<tr class="lastrow">[\s\S]*?<\/tr>/.exec(allPage)?.[0] ?? '';
    const { a } = await read({ [VIEW]: allPage.replace(row, row.repeat(28)) });
    expect(a.sessions).toHaveLength(30);
    expect(a.sessions.at(-1)?.at).toBe('2026-10-02T08:50:00+09:00');
  });
});
