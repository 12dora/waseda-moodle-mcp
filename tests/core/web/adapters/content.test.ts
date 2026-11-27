import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentFunctions, folderFiles, resourceFiles } from '../../../../src/core/moodle/web/adapters/content';
import type { WebRequest, WebSession } from '../../../../src/core/moodle/web/types';
import { makeFakeWebSession } from '../../../helpers/fake-web-session';

const BASE = makeFakeWebSession({}).baseUrl;
const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../../fixtures/web', name), 'utf8').replaceAll('https://wsdmoodle.waseda.jp', BASE);

type Row = Record<string, unknown>;

const call = <T>(web: WebSession, fn: string, cmid?: number) => {
  const impl = contentFunctions[fn];
  if (!impl) throw new Error(`no adapter for ${fn}`);
  return impl(web, { courseids: [99101] }, cmid === undefined ? {} : { cmid }) as Promise<T>;
};
const pages = (web: WebSession, cmid?: number) =>
  call<{ pages: Row[] }>(web, 'mod_page_get_pages_by_courses', cmid).then((r) => r.pages);
const urls = (web: WebSession, cmid?: number) =>
  call<{ urls: Row[] }>(web, 'mod_url_get_urls_by_courses', cmid).then((r) => r.urls);

/** An unfollowed redirect, asserting that the adapter asked not to follow it. */
const redirect = (path: string, location: string) => (req: WebRequest) => {
  expect(req.follow).toBe(false);
  return { url: `${BASE}${path}`, status: 303, html: '', location };
};

const STATE = JSON.stringify({
  cm: [
    { id: '7001', name: '授業の予定', module: 'page', uservisible: true },
    { id: '7002', name: 'Hidden page', module: 'page', uservisible: false },
    { id: '7003', name: '参考サイト', module: 'url', uservisible: true },
  ],
});

describe('mod_page_get_pages_by_courses (web)', () => {
  const PATH = '/mod/page/view.php?id=7001';

  it("reads the hinted page: its intro and its own content box, not the intro's (ja)", async () => {
    const web = makeFakeWebSession({ pages: { [PATH]: fixture('content-page-ja.html') } });
    const [row] = await pages(web, 7001);
    expect(row).toMatchObject({
      id: 7001,
      coursemodule: 7001,
      course: 99101,
      name: '授業の予定',
      contentformat: 1,
      contentfiles: [],
    });
    expect(row?.intro).toContain('予定の説明');
    expect(row?.content).toContain(`${BASE}/pluginfile.php/501/mod_page/content/2/plan.pdf`);
    expect(row?.content).toContain('注意事項');
    expect(row?.content).not.toContain('貼り付けた枠');
    expect(row?.content).not.toContain('最終更新日時');
    expect(web.calls).toEqual([`GET ${PATH}`]);
  });

  it('gives an empty intro when the page shows none (en)', async () => {
    const web = makeFakeWebSession({ pages: { '/mod/page/view.php?id=7002': fixture('content-page-en.html') } });
    const [row] = await pages(web, 7002);
    expect(row).toMatchObject({ name: 'Reading list', intro: '', content: '<ul><li>Chapter 1</li></ul>' });
  });

  it('lists nothing when Moodle sends the request to the course page', async () => {
    const web = makeFakeWebSession({
      pages: {
        [PATH]: () => ({
          url: `${BASE}/course/view.php?id=99101`,
          status: 200,
          html: '<div id="region-main"><div class="generalbox">course</div></div>',
          location: null,
        }),
      },
    });
    expect(await pages(web, 7001)).toEqual([]);
  });

  it('without a hint lists the visible pages by name from the course state, reading no page', async () => {
    const web = makeFakeWebSession({ ajax: { core_courseformat_get_state: STATE } });
    expect(await pages(web)).toEqual([{ id: 7001, coursemodule: 7001, course: 99101, name: '授業の予定' }]);
    expect(web.calls).toEqual(['ajax core_courseformat_get_state']);
  });
});

describe('mod_url_get_urls_by_courses (web)', () => {
  const PATH = '/mod/url/view.php?id=7003&redirect=0';

  it('reads the target of the click-to-open page, not the links of the intro', async () => {
    const web = makeFakeWebSession({ pages: { [PATH]: fixture('content-url-ja.html') } });
    const [row] = await urls(web, 7003);
    expect(row).toMatchObject({
      id: 7003,
      coursemodule: 7003,
      course: 99101,
      name: '参考サイト',
      externalurl: 'https://example.org/reading?unit=1&lang_code=ja',
    });
    expect(row?.intro).toContain('https://example.com/before');
  });

  it('takes the Location when Moodle redirects, leaving the name unknown', async () => {
    const web = makeFakeWebSession({ pages: { [PATH]: redirect(PATH, 'https://example.org/lesson') } });
    expect(await urls(web, 7003)).toEqual([
      { id: 7003, coursemodule: 7003, course: 99101, externalurl: 'https://example.org/lesson' },
    ]);
  });

  it('does not take a redirect to the course page for the target', async () => {
    const web = makeFakeWebSession({ pages: { [PATH]: redirect(PATH, `${BASE}/course/view.php?id=99101`) } });
    expect(await urls(web, 7003)).toEqual([]);
  });

  it('reads the source of an embedded target (en)', async () => {
    const html = `<div id="region-main"><div class="activity-header" data-for="page-activity-header"></div>
      <div role="main"><iframe id="resourceobject" src="https://example.org/embedded"></iframe></div></div>`;
    const [row] = await urls(makeFakeWebSession({ pages: { [PATH]: html } }), 7003);
    expect(row?.externalurl).toBe('https://example.org/embedded');
  });

  it('without a hint lists the URLs by name', async () => {
    const web = makeFakeWebSession({ ajax: { core_courseformat_get_state: STATE } });
    expect(await urls(web)).toEqual([{ id: 7003, coursemodule: 7003, course: 99101, name: '参考サイト' }]);
  });

  it('rejects a course state that is not JSON', async () => {
    const web = makeFakeWebSession({ ajax: { core_courseformat_get_state: '<html>' } });
    await expect(urls(web)).rejects.toMatchObject({ errorcode: 'unreadablepage' });
  });
});

describe('resourceFiles', () => {
  const PATH = '/mod/resource/view.php?id=7004&redirect=1';
  const file = (filename: string, path: string) => ({
    type: 'file',
    filename,
    filepath: '/',
    filesize: 0,
    fileurl: `${BASE}${path}`,
    mimetype: '',
    timemodified: 0,
  });

  it('takes the file from the redirect without downloading it', async () => {
    const target = '/pluginfile.php/502/mod_resource/content/3/guide.pdf?forcedownload=1';
    const web = makeFakeWebSession({ pages: { [PATH]: redirect(PATH, `${BASE}${target}`) } });
    expect(await resourceFiles(web, 7004)).toEqual([file('guide.pdf', target)]);
    expect(web.calls).toEqual([`GET ${PATH}`]);
  });

  it('reads the link of a click-to-continue page (ja)', async () => {
    const web = makeFakeWebSession({ pages: { [PATH]: fixture('content-resource-redirect-ja.html') } });
    const files = await resourceFiles(web, 7004);
    expect(files).toEqual([
      file(
        '授業案内.pdf',
        '/pluginfile.php/502/mod_resource/content/3/%E6%8E%88%E6%A5%AD%E6%A1%88%E5%86%85.pdf?forcedownload=1',
      ),
    ]);
  });

  it('reads an embedded file once and ignores intro images (en)', async () => {
    const web = makeFakeWebSession({ pages: { [PATH]: fixture('content-resource-embed-en.html') } });
    expect(await resourceFiles(web, 7004)).toEqual([
      file('Course guide.pdf', '/pluginfile.php/502/mod_resource/content/1/Course%20guide.pdf'),
    ]);
  });

  it('finds no file in a redirect elsewhere or on a foreign host', async () => {
    const foreign = 'https://files.example.com/pluginfile.php/1/mod_resource/content/0/x.pdf';
    const web = makeFakeWebSession({ pages: { [PATH]: redirect(PATH, foreign) } });
    expect(await resourceFiles(web, 7004)).toEqual([]);
  });
});

describe('folderFiles', () => {
  const PATH = '/mod/folder/view.php?id=7005';

  it('lists the tree with sub-folder paths (ja)', async () => {
    const web = makeFakeWebSession({ pages: { [PATH]: fixture('content-folder-ja.html') } });
    const files = await folderFiles(web, 7005);
    expect(files.map((f) => [f.filename, f.filepath])).toEqual([
      ['発表の説明.pdf', '/'],
      ['sheet.docx', '/第2回/'],
    ]);
    expect(files[1]?.fileurl).toBe(
      `${BASE}/pluginfile.php/503/mod_folder/content/0/%E7%AC%AC2%E5%9B%9E/sheet.docx?forcedownload=1`,
    );
  });

  it('reads only its own block when the folder is shown on the course page', async () => {
    const block = (cmid: number, name: string) =>
      `<li id="module-${cmid}"><a href="${BASE}/pluginfile.php/${cmid}/mod_folder/content/0/${name}">${name}</a></li>`;
    const web = makeFakeWebSession({
      pages: {
        [PATH]: () => ({
          url: `${BASE}/course/view.php?id=99101#module-7005`,
          status: 200,
          html: `<div id="region-main"><ul>${block(7005, 'own.txt')}${block(7006, 'other.txt')}</ul></div>`,
          location: null,
        }),
      },
    });
    expect((await folderFiles(web, 7005)).map((f) => f.filename)).toEqual(['own.txt']);
    expect(web.calls).toEqual([`GET ${PATH}`]);
  });
});
