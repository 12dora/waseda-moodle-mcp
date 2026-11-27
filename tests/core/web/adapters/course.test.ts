import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MoodleError } from '../../../../src/core/errors';
import { courseFunctions } from '../../../../src/core/moodle/web/adapters/course';
import { forumInstanceOf } from '../../../../src/core/moodle/web/adapters/forum';
import { readOverview } from '../../../../src/core/moodle/web/parse/overview';
import type { WebSession } from '../../../../src/core/moodle/web/types';
import { makeFakeWebSession } from '../../../helpers/fake-web-session';

vi.mock('../../../../src/core/moodle/web/adapters/forum', () => ({
  forumInstanceOf: vi.fn(async () => 4501),
}));

const fixture = (name: string) => readFileSync(join(__dirname, '../../../fixtures/web', name), 'utf8');

/** Unix seconds of a Tokyo wall-clock time. */
const jst = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - 9, mi) / 1000;

const COURSE_JA = fixture('course-ja.html');
const COURSE_EN = fixture('course-en.html');

/** The `<li data-for="cmitem">` of one module (what core_course_get_module answers). */
function snippet(html: string, cmid: number): string {
  const at = html.indexOf(`id="module-${cmid}"`);
  const start = html.lastIndexOf('<li', at);
  return html.slice(start, html.indexOf('</li>', at) + 5);
}

const activityPage = (courseId: number, cmid: number, extra = '') =>
  `<html lang="ja"><head><script>M.cfg = {"sesskey":"fakesesskey01","userId":7001,"courseId":${courseId},` +
  `"contextInstanceId":${cmid},"contextid":88201};</script></head><body><div class="page-header-headings">` +
  `<h1 class="h2 mb-0">アナウンスメント</h1></div>${extra}</body></html>`;

const STATE_JA = {
  course: { id: '99101', numsections: 2, sectionlist: ['5001', '5002', '5003'] },
  section: [
    { id: '5001', section: 0, number: 0, title: '一般', visible: true, cmlist: ['7001', '7002', '7010'] },
    { id: '5002', section: 1, number: 1, title: '第1回', visible: true, cmlist: ['7101', '7102', '7103', '7104'] },
    { id: '5003', section: 2, number: 2, title: '第2回', visible: true, cmlist: [] },
    {
      id: '5004',
      section: 3,
      number: 3,
      title: 'オンライン学習',
      visible: true,
      cmlist: ['7011'],
      component: 'mod_subsection',
      itemid: 41,
      parentsectionid: '5001',
    },
  ],
  cm: [
    cm(7001, 'アナウンスメント', 'forum', { url: modUrl('forum', 7001) }),
    cm(7002, '対面授業（金曜日）教室：3-101 ...', 'label', { completionstate: 0 }),
    cm(7010, 'オンライン学習', 'subsection', { hasdelegatedsection: true }),
    cm(7011, 'オンライン学習について', 'forum', { completionstate: 0 }),
    cm(7101, 'ふりかえりシート', 'assign', { completionstate: 1 }),
    cm(7102, '語彙テスト１', 'quiz', { completionstate: 1 }),
    cm(7103, '発表の注意', 'millvi', { uservisible: false, url: modUrl('millvi', 7103) }),
    cm(7104, 'シラバス資料', 'resource', { completionstate: 0 }),
  ],
};

const STATE_EN = {
  course: { id: '99102', sectionlist: ['6001'] },
  section: [{ id: '6001', section: 0, number: 0, title: 'General', visible: true, cmlist: ['8101', '8102'] }],
  cm: [
    cm(8101, 'Essay & Reflection', 'assign', { completionstate: 0 }),
    cm(8102, 'Vocabulary quiz 1', 'quiz', { visible: false, completionstate: 0 }),
  ],
};

/** A cm record of core_courseformat_get_state. */
function cm(id: number, name: string, module: string, extra: Record<string, unknown> = {}) {
  return { id: String(id), name, module, visible: true, uservisible: true, ...extra };
}

function modUrl(mod: string, cmid: number): string {
  return `https://wsdmoodle.waseda.jp/mod/${mod}/view.php?id=${cmid}`;
}

function session(extra: { pages?: Record<string, string>; ajax?: Record<string, unknown> } = {}) {
  return makeFakeWebSession({
    pages: { '/course/view.php?id=99101': COURSE_JA, '/course/view.php?id=99102': COURSE_EN, ...extra.pages },
    ajax: {
      core_courseformat_get_state: (args: Record<string, unknown>) =>
        JSON.stringify(args.courseid === 99101 ? STATE_JA : STATE_EN),
      ...extra.ajax,
    },
  });
}

const call = (web: WebSession, fn: string, params: Record<string, unknown>) => {
  const impl = courseFunctions[fn];
  if (!impl) throw new Error(`${fn} is not emulated`);
  return impl(web, params, {});
};

type Mod = Record<string, unknown> & { id: number };
type Sec = Record<string, unknown> & { modules: Mod[] };

const contents = async (web: WebSession, params: Record<string, unknown>) =>
  (await call(web, 'core_course_get_contents', params)) as Sec[];

const moduleOf = (sections: Sec[], cmid: number) => sections.flatMap((s) => s.modules).find((m) => m.id === cmid);

describe('core_course_get_contents', () => {
  it('builds the section list from the state and the course page (ja), in two calls', async () => {
    const web = session();
    const sections = await contents(web, { courseid: 99101 });
    expect(web.calls).toEqual(['ajax core_courseformat_get_state', 'GET /course/view.php?id=99101']);
    expect(sections.map((s) => [s.id, s.section, s.name])).toEqual([
      [5001, 0, '一般'],
      [5002, 1, '第1回'],
      [5003, 2, '第2回'],
      [5004, 3, 'オンライン学習'],
    ]);
    expect(sections[1]?.summary).toContain('10月8日（木）23:59');
    expect(sections[0]?.modules.map((m) => m.id)).toEqual([7001, 7002, 7010]);
  });

  it('reads ja activity dates, descriptions and both completion kinds', async () => {
    const sections = await contents(session(), { courseid: 99101 });
    expect(moduleOf(sections, 7101)).toMatchObject({
      modname: 'assign',
      instance: 7101,
      url: modUrl('assign', 7101),
      completion: 1,
      completiondata: { state: 1, hascompletion: true, isautomatic: false },
      dates: [
        { label: '開始:', dataid: 'allowsubmissionsfromdate', timestamp: jst(2026, 10, 1, 0, 0) },
        { label: '期限:', dataid: 'duedate', timestamp: jst(2026, 10, 8, 23, 59) },
      ],
    });
    expect(moduleOf(sections, 7101)?.description).toContain('感想を書いてください。');
    expect(moduleOf(sections, 7102)).toMatchObject({
      completion: 2,
      completiondata: { state: 1, isautomatic: true },
      dates: [
        { dataid: 'timeopen', timestamp: jst(2026, 10, 1, 9, 0) },
        { dataid: 'timeclose', timestamp: jst(2026, 10, 15, 23, 59) },
      ],
    });
    expect(moduleOf(sections, 7002)).toMatchObject({ modname: 'label', completion: 1, completiondata: { state: 0 } });
    expect(moduleOf(sections, 7002)?.description).toContain('教室：3-101');
    expect(moduleOf(sections, 7002)).not.toHaveProperty('url');
  });

  it('keeps forum instances out, resources without files, restricted modules not user-visible', async () => {
    const sections = await contents(session(), { courseid: 99101 });
    const forum = moduleOf(sections, 7001);
    expect(forum).toMatchObject({ modname: 'forum', completion: 0, dates: [] });
    expect(forum).not.toHaveProperty('instance');
    expect(moduleOf(sections, 7104)).toMatchObject({ contents: [], completion: 2, completiondata: { state: 0 } });
    expect(moduleOf(sections, 7103)).toMatchObject({ uservisible: false, visible: 1 });
  });

  it('flattens a subsection: delegated section listed normally, the subsection module stays clean', async () => {
    const sections = await contents(session(), { courseid: 99101 });
    const delegated = sections.find((s) => s.id === 5004);
    expect(delegated).toMatchObject({ component: 'mod_subsection', itemid: 41 });
    expect(delegated?.summary).toContain('提出〆切');
    expect(delegated?.modules.map((m) => m.id)).toEqual([7011]);
    // the forum inside the delegated section: forum "終了日時" is its due date, manual completion
    expect(moduleOf(sections, 7011)).toMatchObject({
      completion: 1,
      dates: [{ label: '終了日時:', dataid: 'duedate', timestamp: jst(2026, 11, 5, 12, 30) }],
    });
    // the subsection module itself takes nothing from the modules it contains
    expect(moduleOf(sections, 7010)).toMatchObject({ modname: 'subsection', completion: 0, dates: [] });
    expect(moduleOf(sections, 7010)).not.toHaveProperty('description');
  });

  it('reads en dates and completion', async () => {
    const sections = await contents(session(), { courseid: 99102 });
    expect(moduleOf(sections, 8101)).toMatchObject({
      name: 'Essay & Reflection',
      completion: 1,
      completiondata: { state: 0 },
      dates: [
        { label: 'Opened:', dataid: 'allowsubmissionsfromdate', timestamp: jst(2026, 10, 1, 0, 0) },
        { label: 'Due:', dataid: 'duedate', timestamp: jst(2026, 10, 8, 23, 59) },
      ],
    });
    expect(moduleOf(sections, 8102)).toMatchObject({
      visible: 0,
      completion: 2,
      completiondata: { state: 0, isautomatic: true },
      dates: [
        { label: 'Opens:', dataid: 'timeopen', timestamp: jst(2026, 10, 1, 9, 0) },
        { label: 'Closes:', dataid: 'timeclose', timestamp: jst(2026, 10, 15, 23, 59) },
      ],
    });
    expect(sections[0]?.summary).toContain('Welcome to Example Course.');
  });

  it('cmid option: that module in its section, from the cm snippet (no course page)', async () => {
    const web = session({ ajax: { core_course_get_module: snippet(COURSE_JA, 7101) } });
    const sections = await contents(web, { courseid: 99101, options: [{ name: 'cmid', value: 7101 }] });
    expect(web.calls).toEqual(['ajax core_courseformat_get_state', 'ajax core_course_get_module']);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ id: 5002, section: 1, summary: '' });
    expect(sections[0]?.modules).toHaveLength(1);
    expect(sections[0]?.modules[0]).toMatchObject({
      id: 7101,
      completion: 1,
      dates: [{ dataid: 'allowsubmissionsfromdate' }, { dataid: 'duedate' }],
    });
  });

  it('cmid option: unknown module → no section; a refused snippet still lists the state module', async () => {
    const refused = session({
      ajax: {
        core_course_get_module: () => {
          throw new MoodleError('No access', 'nopermissions');
        },
      },
    });
    expect(await contents(refused, { courseid: 99101, options: [{ name: 'cmid', value: 9999 }] })).toEqual([]);
    const sections = await contents(refused, { courseid: 99101, options: [{ name: 'cmid', value: 7102 }] });
    expect(sections[0]?.modules[0]).toMatchObject({ id: 7102, dates: [], completiondata: { state: 1 } });
    expect(sections[0]?.modules[0]).not.toHaveProperty('completion');
  });

  it('sectionnumber option: only that section', async () => {
    const sections = await contents(session(), { courseid: 99101, options: [{ name: 'sectionnumber', value: 3 }] });
    expect(sections.map((s) => s.id)).toEqual([5004]);
  });

  it('refuses an unreadable state', async () => {
    const web = session({ ajax: { core_courseformat_get_state: 'not json' } });
    await expect(contents(web, { courseid: 99101 })).rejects.toMatchObject({ errorcode: 'invalidresponse' });
  });
});

describe('core_completion_get_activities_completion_status', () => {
  it('lists tracked modules from the course page (1 manual, 2 automatic)', async () => {
    const web = session();
    const res = (await call(web, 'core_completion_get_activities_completion_status', {
      courseid: 99101,
      userid: 7001,
    })) as { statuses: Array<{ cmid: number; state: number; tracking: number }> };
    expect(res.statuses.map((s) => [s.cmid, s.tracking, s.state])).toEqual([
      [7002, 1, 0],
      [7011, 1, 0],
      [7101, 1, 1],
      [7102, 2, 1],
      [7104, 2, 0],
    ]);
    expect(web.calls).toEqual(['GET /course/view.php?id=99101']);
  });
});

describe('core_course_get_course_module', () => {
  it('assign: modname/name from the snippet, course from the activity page, instance = cmid', async () => {
    const web = session({
      ajax: { core_course_get_module: snippet(COURSE_JA, 7101) },
      pages: { '/mod/assign/view.php?id=7101': activityPage(99101, 7101) },
    });
    const res = await call(web, 'core_course_get_course_module', { cmid: 7101 });
    expect(res).toMatchObject({
      cm: { id: 7101, course: 99101, modname: 'assign', instance: 7101, name: 'ふりかえりシート' },
    });
  });

  it('forum: the real instance from the forum adapter; null when it is not known', async () => {
    const web = session({
      ajax: { core_course_get_module: snippet(COURSE_JA, 7001) },
      pages: { '/mod/forum/view.php?id=7001': activityPage(99101, 7001) },
    });
    const res = await call(web, 'core_course_get_course_module', { cmid: 7001 });
    expect(res).toMatchObject({ cm: { id: 7001, course: 99101, modname: 'forum', instance: 4501 } });
    expect(forumInstanceOf).toHaveBeenCalledWith(web, 7001, 99101, 'forum');
    vi.mocked(forumInstanceOf).mockResolvedValueOnce(null);
    const unknown = await call(web, 'core_course_get_course_module', { cmid: 7001 });
    expect(unknown).toMatchObject({ cm: { instance: null } });
  });

  it('an inaccessible module is invalidrecord', async () => {
    const web = session({
      ajax: {
        core_course_get_module: () => {
          throw new MoodleError('Invalid course module ID', 'invalidcoursemodule');
        },
      },
    });
    await expect(call(web, 'core_course_get_course_module', { cmid: 9999 })).rejects.toMatchObject({
      errorcode: 'invalidrecord',
    });
  });

  it('by instance: a forum through view.php?f=, other modules through the cmid surrogate', async () => {
    const web = session({
      ajax: { core_course_get_module: snippet(COURSE_JA, 7101) },
      pages: {
        '/mod/forum/view.php?f=4501': activityPage(99101, 7001),
        '/mod/assign/view.php?id=7101': activityPage(99101, 7101),
      },
    });
    const forum = await call(web, 'core_course_get_course_module_by_instance', { module: 'forum', instance: 4501 });
    expect(forum).toMatchObject({
      cm: { id: 7001, course: 99101, modname: 'forum', instance: 4501, name: 'アナウンスメント' },
    });
    const assign = await call(web, 'core_course_get_course_module_by_instance', { module: 'assign', instance: 7101 });
    expect(assign).toMatchObject({ cm: { id: 7101, modname: 'assign', instance: 7101 } });
  });
});

describe('core_enrol_get_users_courses', () => {
  it('maps the recent courses (timeaccess → lastaccess)', async () => {
    const seen: Record<string, unknown>[] = [];
    const web = session({
      ajax: {
        core_course_get_recent_courses: (args: Record<string, unknown>) => {
          seen.push(args);
          return [
            { id: 99101, fullname: '総合日本語３Ｘ', shortname: 'JP3X', timeaccess: 1790000000 },
            { id: 99102, fullname: 'Example Course' },
          ];
        },
      },
    });
    const res = await call(web, 'core_enrol_get_users_courses', { userid: 7001, returnusercount: 0 });
    expect(res).toEqual([
      { id: 99101, fullname: '総合日本語３Ｘ', shortname: 'JP3X', lastaccess: 1790000000 },
      { id: 99102, fullname: 'Example Course' },
    ]);
    expect(seen).toEqual([{ userid: 7001, limit: 0 }]);
  });
});

describe('readOverview', () => {
  it('one page for every requested type; machine values, texts and the grade alias (ja)', async () => {
    const path = '/course/overview.php?id=99101&expand[]=assign&expand[]=quiz';
    const web = makeFakeWebSession({ pages: { [path]: fixture('overview-ja.html') } });
    const rows = await readOverview(web, 99101, ['quiz', 'assign', 'quiz']);
    expect(web.calls).toEqual([`GET ${path}`]);
    expect([...rows.keys()]).toEqual([7101, 7102]);
    expect(rows.get(7101)?.values).toMatchObject({
      name: 'ふりかえりシート',
      duedate: '1791471540',
      completion: '1',
      grade: '85.00000',
      評点: '85.00000',
    });
    expect(rows.get(7101)?.text.submissionstatus).toBe('評定のため提出済み');
    expect(rows.get(7102)?.values).toEqual({ name: '語彙テスト１', duedate: '' });
    expect(rows.get(7102)?.text.grade).toBe('-');
  });

  it('en grade column and decoded values', async () => {
    const path = '/course/overview.php?id=99102&expand[]=assign';
    const web = makeFakeWebSession({ pages: { [path]: fixture('overview-en.html') } });
    const rows = await readOverview(web, 99102, ['assign']);
    expect(rows.get(8101)?.values).toMatchObject({ name: 'Essay & Reflection', grade: '9.50000', Grade: '9.50000' });
  });
});
