/**
 * The console's course overview on the web channel (every status read is a page Moodle serialises): what it costs in
 * Moodle requests, against the due list's full plan for the same calendar. Invented data only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import { getCourseOverview } from '../../src/core/services/course-overview';
import { getDueItems } from '../../src/core/services/due';
import { makeFakeContext } from '../helpers/fake-context';
import { makeWebApi, type WebApi } from './web-channel';

const BASE = 'https://wsdmoodle.waseda.jp';
const COURSES = [1, 2, 3, 4, 5, 6, 7, 8];
const courseId = (n: number) => 99100 + n;
const lightOverview = (n: number) =>
  `/course/overview.php?id=${courseId(n)}&expand[]=assign&expand[]=questionnaire&expand[]=quiz`;
/** 10-1<n> at hh:mm JST, unix seconds. */
const due = (n: number, hh: number) => Date.UTC(2026, 9, 10 + n, hh - 9, 0) / 1000;

const KINDS = [
  { modulename: 'quiz', base: 7300, hh: 21 },
  { modulename: 'questionnaire', base: 7400, hh: 22 },
  { modulename: 'assign', base: 7200, hh: 23 },
] as const;

/** Course n: a quiz, a questionnaire and an assignment due on 10-1<n> (calendar action events). */
function events() {
  return COURSES.flatMap((n) =>
    KINDS.map((k) => {
      const cmid = k.base + n;
      const url = `${BASE}/mod/${k.modulename}/view.php?id=${cmid}`;
      return {
        id: cmid * 10,
        name: `課題 ${cmid}`,
        activityname: `課題 ${cmid}`,
        eventtype: 'due',
        modulename: k.modulename,
        instance: cmid,
        timesort: due(n, k.hh),
        url,
        course: { id: courseId(n), fullname: `総合日本語３Ｘ ${n}` },
        action: { name: 'Add submission', url, actionable: true },
      };
    }),
  );
}

const table = (rows: string) => `<div id="region-main"><table><tbody>${rows}</tbody></table></div>`;
const overviewPage = (n: number) =>
  table(`<tr data-mdl-overview-cmid="${7200 + n}">
<td data-mdl-overview-item="name" data-mdl-overview-value="課題">x</td>
<td data-mdl-overview-item="submissionstatus" data-mdl-overview-value="評定のために提出済み">x</td></tr>
<tr data-mdl-overview-cmid="${7400 + n}">
<td data-mdl-overview-item="responded" data-mdl-overview-value="1"> </td></tr>`);

function webApi(): WebApi {
  return makeWebApi({
    pages: Object.fromEntries(COURSES.map((n) => [lightOverview(n), overviewPage(n)])),
    handlers: {
      core_course_get_enrolled_courses_by_timeline_classification: {
        courses: COURSES.map((n) => ({
          id: courseId(n),
          fullname: `総合日本語３Ｘ ${n}`,
          shortname: `C${n}`,
          idnumber: `2026160000${String(n).padStart(4, '0')}16`,
          viewurl: `${BASE}/course/view.php?id=${courseId(n)}`,
        })),
      },
      core_enrol_get_users_courses: [],
      core_calendar_get_action_events_by_timesort: { events: events() },
      mod_quiz_get_user_quiz_attempts: { attempts: [] },
      mod_quiz_get_attempt_access_information: { preventnewattemptreasons: [] },
    },
  });
}

/** Moodle requests on the web session: pages, plus one per other call, a quiz's two reads sharing its view page. */
function requests(api: WebApi): number {
  const quizPages = new Set(api.calls.filter((c) => c.fn.startsWith('mod_quiz_')).map((c) => c.hint?.cmid));
  const others = api.calls.filter((c) => !c.fn.startsWith('mod_quiz_')).length;
  return api.pageCalls.length + quizPages.size + others;
}

function context(api: WebApi): ServiceContext {
  const { ctx } = makeFakeContext({ user: { lang: 'ja', settings: { myCourseIds: COURSES.map(courseId) } } });
  return { ...ctx, syllabusLookup: false, moodle: async () => api };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 500 })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('getCourseOverview on the web channel', () => {
  it('costs 10 Moodle requests: courses and calendar, then 6 status pages (nearest deadlines)', async () => {
    const api = webApi();
    const overview = await getCourseOverview(context(api));

    expect(overview.dueError).toBe(false);
    // timeline + enrolment (lastaccess) + the scope's 30-day event signal + the 90-day calendar page, then 2 quiz
    // pages + 4 course overview pages
    expect(requests(api)).toBe(10);
    expect([...api.pageCalls].sort()).toEqual([1, 2, 3, 4].map((n) => `GET ${lightOverview(n)}`).sort());
    expect(api.pageCalls.some((p) => p.includes('/mod/questionnaire/'))).toBe(false);

    const first = overview.courses.find((c) => c.id === courseId(1));
    expect(first?.counts).toEqual({ overdue: 0, todo: 1, draft: 0, done: 2 }); // quiz unattempted; both handed in
    const far = overview.courses.find((c) => c.id === courseId(8));
    // beyond the light plan's pages: listed without a status, so counted as to do
    expect(far?.items.map((i) => i.submission)).toEqual([null, null, null]);
    expect(far?.counts).toEqual({ overdue: 0, todo: 3, draft: 0, done: 0 });
  });

  it('the same calendar through the due list (full plan, as the overview read it before) costs 26', async () => {
    const api = webApi();
    await getDueItems(context(api), { daysAhead: 60, overdueDays: 30, sweep: 'cached', maxSubmissionChecks: 150 });
    // 4 fixed + 6 quiz pages + 8 questionnaire pages + 8 course overview pages
    expect(requests(api)).toBe(26);
  });
});
