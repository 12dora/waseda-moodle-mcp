import { describe, expect, it } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import { InvalidInput, NotFound } from '../../src/core/errors';
import { renderCourseDownloadLinks } from '../../src/core/mcp/render/downloads';
import { sessionFileUrl } from '../../src/core/moodle/wire';
import { downloadCourseFiles } from '../../src/core/services/downloads';
import { moodleFilePath, streamDownload } from '../../src/core/services/files';
import { BASE_URL, createTestContext, PUBLIC_URL, type TestContext } from '../helpers/fake-context-be4';
import { makeWebApi, redirectTo, type WebApiOptions } from './web-channel';

const COURSE = 99101;
const ticketOf = (url: string | null) => (url ?? '').split('/').pop() ?? '';
const fileEntry = (path: string, filename: string, filepath = '/') => ({
  type: 'file',
  filename,
  filepath,
  filesize: 2048,
  fileurl: `${BASE_URL}/webservice/pluginfile.php/${path}/${encodeURIComponent(filename)}?forcedownload=1`,
  mimetype: 'application/pdf',
  timemodified: 1_790_000_000,
});

const resource = (id: number, name: string, files: object[] = []) => ({
  id,
  name,
  modname: 'resource',
  contents: files,
});
const assignments = (cmid: number, files: object[]) => ({
  courses: [{ id: COURSE, assignments: [{ cmid, introattachments: files }] }],
});

/** Invented course: section 0 (general) and section 1 with a resource, a folder, a page and an assignment. */
function wsSections() {
  return [
    { id: 1, section: 0, name: '一般', modules: [resource(7001, 'シラバス')] },
    {
      id: 2,
      section: 1,
      name: '第1回',
      modules: [
        resource(7002, '講義資料', [fileEntry('501/mod_resource/content/1', 'slides.pdf')]),
        {
          id: 7003,
          name: '配布フォルダ',
          modname: 'folder',
          contents: [
            fileEntry('503/mod_folder/content/0', 'a.pdf'),
            fileEntry('503/mod_folder/content/0', 'b.docx', '/week2/'),
          ],
        },
        {
          id: 7004,
          name: '読み物',
          modname: 'page',
          contents: [fileEntry('504/mod_page/content/3', 'index.html'), fileEntry('504/mod_page/content/3', 'map.png')],
        },
        { id: 7005, name: 'レポート', modname: 'assign' },
        { ...resource(7006, '隠し資料'), uservisible: false },
      ],
    },
  ];
}

async function verified(t: TestContext, url: string | null) {
  return t.signer.verify<Record<string, unknown>>(ticketOf(url));
}

describe('downloadCourseFiles on the web-service channel', () => {
  it('lists resource and folder files from one contents call, a directory per section, signed links', async () => {
    const t = createTestContext({ handlers: { core_course_get_contents: wsSections() } });
    const r = await downloadCourseFiles(t.ctx, COURSE);
    expect(t.moodle.calls.map((c) => c.fn)).toEqual(['core_course_get_contents']);
    expect(r.files.map((f) => f.path)).toEqual([
      '01 第1回/slides.pdf',
      '01 第1回/配布フォルダ/a.pdf',
      '01 第1回/配布フォルダ/week2/b.docx',
    ]);
    expect(r.files[0]).toMatchObject({ section: 1, activity: '講義資料', cmid: 7002, kind: 'resource', size: 2048 });
    expect(r.files[0]?.url?.startsWith(`${PUBLIC_URL}/f/`)).toBe(true);
    expect(await verified(t, r.files[0]?.url ?? null)).toMatchObject({
      k: 'dl',
      u: t.ctx.user.id,
      p: '/webservice/pluginfile.php/501/mod_resource/content/1/slides.pdf?forcedownload=1',
      n: 'slides.pdf',
    });
    expect(r).toMatchObject({ viewed: {}, remaining: 0, nextCursor: null, failures: [], activitiesRead: 3 });
    expect(r.expiresAt).not.toBeNull();
  });

  it('adds page files (not the page text) and assignment instruction files when asked', async () => {
    const t = createTestContext({
      handlers: {
        core_course_get_contents: wsSections(),
        mod_assign_get_assignments: assignments(7005, [fileEntry('505/mod_assign/introattachment/0', 'task.pdf')]),
      },
    });
    const r = await downloadCourseFiles(t.ctx, COURSE, { kinds: ['page', 'assign'] });
    expect(r.files.map((f) => f.path)).toEqual(['01 第1回/読み物/map.png', '01 第1回/レポート/task.pdf']);
    expect(t.moodle.callsTo('mod_assign_get_assignments')).toEqual([{ courseids: [COURSE] }]);
  });

  it("adds the assignment's activity instruction files to the description's, each file once", async () => {
    const task = fileEntry('505/mod_assign/introattachment/0', 'task.pdf');
    const rubric = fileEntry('505/mod_assign/activityattachment/0', 'rubric.pdf');
    const form = fileEntry('505/mod_assign/activityattachment/0', 'form.docx');
    const assign = { cmid: 7005, introattachments: [task, rubric], activityattachments: [rubric, form] };
    const t = createTestContext({
      handlers: {
        core_course_get_contents: wsSections(),
        mod_assign_get_assignments: { courses: [{ id: COURSE, assignments: [assign] }] },
      },
    });
    const r = await downloadCourseFiles(t.ctx, COURSE, { kinds: ['assign'] });
    expect(r.files.map((f) => f.path)).toEqual([
      '01 第1回/レポート/task.pdf',
      '01 第1回/レポート/rubric.pdf',
      '01 第1回/レポート/form.docx',
    ]);
  });

  it('decodes HTML entities in section and activity names before they become paths', async () => {
    const folder = {
      id: 7201,
      name: 'Slides &amp; Notes',
      modname: 'folder',
      contents: [fileEntry('701/mod_folder/content/0', 'qa.pdf')],
    };
    const sections = [{ section: 3, name: 'Week 3 Q&amp;A', modules: [folder] }];
    const t = createTestContext({ handlers: { core_course_get_contents: sections } });
    const r = await downloadCourseFiles(t.ctx, COURSE);
    const paths = r.files.map((f) => [f.activity, f.path]);
    expect(paths).toEqual([['Slides & Notes', '03 Week 3 Q&A/Slides & Notes/qa.pdf']]);
  });

  it('reads one section only and refuses an unknown section or cursor', async () => {
    const t = createTestContext({ handlers: { core_course_get_contents: wsSections() } });
    const r = await downloadCourseFiles(t.ctx, COURSE, { section: 0 });
    expect(t.moodle.callsTo('core_course_get_contents')[0]).toEqual({
      courseid: COURSE,
      options: [{ name: 'sectionnumber', value: 0 }],
    });
    expect(r.section).toBe(0);
    expect(r.files).toEqual([]); // the syllabus resource lists no file
    await expect(downloadCourseFiles(t.ctx, COURSE, { section: 9 })).rejects.toBeInstanceOf(NotFound);
    await expect(downloadCourseFiles(t.ctx, COURSE, { cursor: 123456 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(downloadCourseFiles(t.ctx, 0)).rejects.toBeInstanceOf(InvalidInput);
  });

  it('keeps two files of the same name apart', async () => {
    const sections = [
      {
        section: 2,
        name: '第2回',
        modules: [
          resource(7101, 'A', [fileEntry('601/mod_resource/content/1', 'notes.pdf')]),
          resource(7102, 'B', [fileEntry('602/mod_resource/content/1', 'Notes.pdf')]),
        ],
      },
    ];
    const t = createTestContext({ handlers: { core_course_get_contents: sections } });
    const r = await downloadCourseFiles(t.ctx, COURSE);
    expect(r.files.map((f) => f.path)).toEqual(['02 第2回/notes.pdf', '02 第2回/Notes (2).pdf']);
  });
});

// ------------------------------------------------------------------ web channel

function webSections(resources: number[], extra: object[] = []) {
  return [
    {
      section: 1,
      name: '第1回',
      modules: [...resources.map((id) => resource(id, `資料${id}`)), ...extra],
    },
  ];
}

const resourcePages = (ids: number[]): WebApiOptions['pages'] =>
  Object.fromEntries(
    ids.map((id) => [
      `/mod/resource/view.php?id=${id}&redirect=1`,
      () => redirectTo(`/pluginfile.php/${id + 1000}/mod_resource/content/1/handout-${id}.pdf`),
    ]),
  );

function webContext(opts: WebApiOptions) {
  const t = createTestContext();
  const api = makeWebApi(opts);
  const ctx: ServiceContext = { ...t.ctx, moodle: async () => api };
  return { t, api, ctx };
}

describe('downloadCourseFiles on the web session', () => {
  it('resolves each resource from its view page, links each folder as one ZIP and reports the views', async () => {
    const folder = { id: 7300, name: '配布フォルダ', modname: 'folder', contents: [] };
    const { t, api, ctx } = webContext({
      pages: resourcePages([7201, 7202]),
      handlers: { core_course_get_contents: webSections([7201, 7202], [folder]) },
    });
    const r = await downloadCourseFiles(ctx, COURSE);
    expect(api.pageCalls).toEqual([
      'GET /mod/resource/view.php?id=7201&redirect=1',
      'GET /mod/resource/view.php?id=7202&redirect=1',
    ]);
    expect(r.files.map((f) => f.path)).toEqual([
      '01 第1回/handout-7201.pdf',
      '01 第1回/handout-7202.pdf',
      '01 第1回/配布フォルダ.zip',
    ]);
    expect(await verified(t, r.files[0]?.url ?? null)).toMatchObject({
      p: '/webservice/pluginfile.php/8201/mod_resource/content/1/handout-7201.pdf',
    });
    expect(await verified(t, r.files[2]?.url ?? null)).toMatchObject({
      p: '/mod/folder/download_folder.php?id=7300',
      n: '配布フォルダ.zip',
    });
    expect(r.files[2]?.zip).toBe(true);
    expect(r.viewed).toEqual({ resource: 2 });
    const text = renderCourseDownloadLinks(r);
    expect(text).toContain('Opening 2 resources counted as viewing them on Moodle');
    expect(text).toContain(`curl -fL --create-dirs -o 'course-${COURSE}/01 第1回/handout-7201.pdf' '${PUBLIC_URL}/f/`);
  });

  it('pages through a large course with a cursor (30 activity pages per call)', async () => {
    const ids = Array.from({ length: 33 }, (_, i) => 7400 + i);
    const opts = { pages: resourcePages(ids), handlers: { core_course_get_contents: webSections(ids) } };
    const first = webContext(opts);
    const r1 = await downloadCourseFiles(first.ctx, COURSE);
    expect(r1.files).toHaveLength(30);
    expect(r1).toMatchObject({ remaining: 3, nextCursor: 7430, activitiesRead: 30 });
    expect(first.api.callsMade).toBeLessThanOrEqual(32);
    expect(renderCourseDownloadLinks(r1)).toContain('3 activities left: call download_course_files again');
    const second = webContext(opts);
    const r2 = await downloadCourseFiles(second.ctx, COURSE, { cursor: r1.nextCursor ?? undefined });
    expect(r2.files.map((f) => f.cmid)).toEqual([7430, 7431, 7432]);
    expect(r2).toMatchObject({ remaining: 0, nextCursor: null });
  });

  it('reports a resource whose page cannot be read and still lists the rest', async () => {
    const { ctx } = webContext({
      pages: resourcePages([7501]),
      handlers: { core_course_get_contents: webSections([7501, 7502]) },
    });
    const r = await downloadCourseFiles(ctx, COURSE);
    expect(r.files.map((f) => f.cmid)).toEqual([7501]);
    expect(r.failures).toEqual([{ cmid: 7502, activity: '資料7502', reason: 'not found' }]);
    expect(r.viewed).toEqual({ resource: 2 });
  });

  it('reads page files from the page content and assignment files with the cmid hint', async () => {
    const extra = [
      { id: 7601, name: '読み物', modname: 'page' },
      { id: 7602, name: 'レポート', modname: 'assign' },
    ];
    const taskUrl = `${BASE_URL}/pluginfile.php/9602/mod_assign/introattachment/0/task.pdf`;
    const content =
      '<p><a href="https://wsdmoodle.waseda.jp/pluginfile.php/9601/mod_page/content/2/%E5%9B%B3.png">図</a>' +
      '<img src="https://wsdmoodle.waseda.jp/pluginfile.php/9601/mod_page/content/2/%E5%9B%B3.png">' +
      '<a href="https://example.com/other.pdf">外部</a></p>';
    const { api, ctx } = webContext({
      handlers: {
        core_course_get_contents: webSections([], extra),
        mod_page_get_pages_by_courses: { pages: [{ coursemodule: 7601, content, contentfiles: [] }] },
        mod_assign_get_assignments: assignments(7602, [{ filename: 'task.pdf', filepath: '/', fileurl: taskUrl }]),
      },
    });
    const r = await downloadCourseFiles(ctx, COURSE, { kinds: ['page', 'assign'] });
    expect(r.files.map((f) => f.path)).toEqual(['01 第1回/読み物/図.png', '01 第1回/レポート/task.pdf']);
    expect(api.calls.find((c) => c.fn === 'mod_assign_get_assignments')?.hint).toEqual({ cmid: 7602 });
    expect(api.calls.find((c) => c.fn === 'mod_page_get_pages_by_courses')?.hint).toEqual({ cmid: 7601 });
    expect(r.viewed).toEqual({ page: 1, assign: 1 });
  });
});

// ------------------------------------------------------------------ path rules

describe('folder ZIP path rules', () => {
  it('lets the web session fetch exactly download_folder.php?id=<cmid>', () => {
    expect(sessionFileUrl(BASE_URL, `${BASE_URL}/mod/folder/download_folder.php?id=7005`)).toBe(
      `${BASE_URL}/mod/folder/download_folder.php?id=7005`,
    );
    expect(() => sessionFileUrl(BASE_URL, `${BASE_URL}/mod/folder/download_folder.php?id=7005&x=1`)).toThrow(
      InvalidInput,
    );
    expect(() => sessionFileUrl(BASE_URL, `${BASE_URL}/mod/folder/view.php?id=7005`)).toThrow(InvalidInput);
    expect(() => sessionFileUrl(BASE_URL, 'https://evil.example.com/mod/folder/download_folder.php?id=7005')).toThrow(
      InvalidInput,
    );
  });

  it('puts the ZIP path into tickets as it is and refuses tickets for other pages', async () => {
    expect(moodleFilePath(BASE_URL, `${BASE_URL}/mod/folder/download_folder.php?id=7005`)).toBe(
      '/mod/folder/download_folder.php?id=7005',
    );
    expect(() => moodleFilePath(BASE_URL, `${BASE_URL}/mod/folder/download_folder.php?id=0`)).toThrow(InvalidInput);
    const t = createTestContext();
    const env = { store: t.store, signer: t.signer, makeMoodle: async () => t.moodle };
    const bad = await t.signer.sign({ k: 'dl', u: t.ctx.user.id, p: '/course/view.php?id=1', n: 'x' }, 60);
    const res = await streamDownload(env, bad, new Request(`${PUBLIC_URL}/f/${bad}`));
    expect(res.status).toBe(404);
    expect(t.moodle.fetched).toEqual([]);
  });
});
