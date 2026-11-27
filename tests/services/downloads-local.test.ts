import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import { InvalidInput } from '../../src/core/errors';
import { renderCourseDownloadLocal } from '../../src/core/mcp/render/downloads';
import { downloadCourseFiles } from '../../src/core/services/downloads';
import { BASE_URL, createTestContext } from '../helpers/fake-context-be4';
import { makeWebApi } from './web-channel';

const COURSE = 99101;
const MB = 1024 * 1024;

let tmp: string;
const savedTmp = process.env.TMPDIR;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'wmm-host-'));
  process.env.TMPDIR = tmp;
});
afterEach(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  await rm(tmp, { recursive: true, force: true });
});

const fileUrl = (ctx: number, name: string) =>
  `${BASE_URL}/webservice/pluginfile.php/${ctx}/mod_resource/content/1/${name}`;
const entry = (ctx: number, name: string, filesize = 4) => ({
  type: 'file',
  filename: name,
  filepath: '/',
  filesize,
  fileurl: fileUrl(ctx, name),
});
const resource = (id: number, files: object[]) => ({ id, name: `資料${id}`, modname: 'resource', contents: files });
const sections = (modules: object[]) => [{ section: 2, name: '第2回', modules }];

describe('downloadCourseFiles in local (stdio) mode', () => {
  it('saves every file into one new directory with a folder per section and reports what failed', async () => {
    const modules = [resource(7101, [entry(601, 'notes.pdf')]), resource(7102, [entry(602, 'gone.pdf')])];
    const t = createTestContext({ mode: 'stdio', handlers: { core_course_get_contents: sections(modules) } });
    t.moodle.files.set(fileUrl(601, 'notes.pdf'), { body: 'note', contentType: 'application/pdf' });
    const r = await downloadCourseFiles(t.ctx, COURSE);
    expect(r.directory?.startsWith(join(tmp, 'wmm-'))).toBe(true);
    const dir = r.directory ?? '';
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ path: '02 第2回/notes.pdf', url: null });
    expect(r.files[0]?.localPath).toBe(join(dir, '02 第2回', 'notes.pdf'));
    expect(await readFile(join(dir, '02 第2回', 'notes.pdf'), 'utf8')).toBe('note');
    expect(r.failures).toEqual([
      { cmid: 7102, activity: '資料7102', file: '02 第2回/gone.pdf', reason: expect.stringContaining('no longer') },
    ]);
    expect(await readdir(join(dir, '02 第2回'))).toEqual(['notes.pdf']);
    expect(r.expiresAt).toBeNull();
    const text = renderCourseDownloadLocal(r);
    expect(text).toContain(`saved 1 file to ${dir}`);
    expect(text).toContain('Not downloaded:');
  });

  it('continues in the given directory with a cursor and never overwrites a file', async () => {
    const modules = [resource(7101, [entry(601, 'notes.pdf')]), resource(7102, [entry(602, 'notes.pdf')])];
    const t = createTestContext({ mode: 'stdio', handlers: { core_course_get_contents: sections(modules) } });
    t.moodle.files.set(fileUrl(601, 'notes.pdf'), { body: 'one' });
    t.moodle.files.set(fileUrl(602, 'notes.pdf'), { body: 'two' });
    const first = await downloadCourseFiles(t.ctx, COURSE);
    const dir = first.directory ?? '';
    expect(first.files.map((f) => f.path)).toEqual(['02 第2回/notes.pdf', '02 第2回/notes (2).pdf']);
    const again = await downloadCourseFiles(t.ctx, COURSE, { cursor: 7102, destDir: dir });
    expect(again.directory).toBe(dir);
    expect(again.files.map((f) => f.path)).toEqual(['02 第2回/notes (3).pdf']);
    expect(await readFile(join(dir, '02 第2回', 'notes.pdf'), 'utf8')).toBe('one');
    expect(await readFile(join(dir, '02 第2回', 'notes (3).pdf'), 'utf8')).toBe('two');
  });

  it('creates the new directory inside dest_dir; refuses a relative or missing one before asking Moodle', async () => {
    const modules = [resource(7101, [entry(601, 'notes.pdf')])];
    const t = createTestContext({ mode: 'stdio', handlers: { core_course_get_contents: sections(modules) } });
    t.moodle.files.set(fileUrl(601, 'notes.pdf'), { body: 'note' });
    const parent = await mkdtemp(join(tmp, 'dest-'));
    const r = await downloadCourseFiles(t.ctx, COURSE, { destDir: parent });
    expect(r.directory?.startsWith(join(parent, 'wmm-'))).toBe(true);
    const before = t.moodle.calls.length;
    await expect(downloadCourseFiles(t.ctx, COURSE, { destDir: 'relative/dir' })).rejects.toBeInstanceOf(InvalidInput);
    await expect(downloadCourseFiles(t.ctx, COURSE, { destDir: join(tmp, 'missing') })).rejects.toBeInstanceOf(
      InvalidInput,
    );
    expect(t.moodle.calls.length).toBe(before);
  });

  it('leaves files over 50 MB on Moodle and gives their browser address', async () => {
    const modules = [resource(7101, [entry(601, 'video.mp4', 60 * MB)])];
    const t = createTestContext({ mode: 'stdio', handlers: { core_course_get_contents: sections(modules) } });
    const r = await downloadCourseFiles(t.ctx, COURSE);
    expect(r.files[0]).toMatchObject({
      localPath: null,
      url: `${BASE_URL}/pluginfile.php/601/mod_resource/content/1/video.mp4`,
    });
    expect(t.moodle.fetched).toEqual([]);
    expect(renderCourseDownloadLocal(r)).toContain('Too large to download automatically');
  });
});

describe('downloadCourseFiles in local mode on the web session', () => {
  function webStdio(zips: Record<string, string>) {
    const t = createTestContext({ mode: 'stdio' });
    const folders = [
      { id: 7301, name: '配布フォルダ', modname: 'folder' },
      { id: 7302, name: '非公開フォルダ', modname: 'folder' },
    ];
    const api = makeWebApi({ handlers: { core_course_get_contents: sections(folders) } });
    const fetched: string[] = [];
    api.fetchFile = async (url) => {
      fetched.push(url);
      const body = zips[url];
      if (body === undefined) return new Response(null, { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/zip' } });
    };
    const ctx: ServiceContext = { ...t.ctx, moodle: async () => api };
    return { ctx, fetched };
  }

  it('downloads each folder as its ZIP (counted as a view) and explains a folder without one', async () => {
    const zip = `${BASE_URL}/mod/folder/download_folder.php?id=7301`;
    const { ctx, fetched } = webStdio({ [zip]: 'PK-zip' });
    const r = await downloadCourseFiles(ctx, COURSE);
    expect(fetched).toEqual([zip, `${BASE_URL}/mod/folder/download_folder.php?id=7302`]);
    expect(r.files.map((f) => f.path)).toEqual(['02 第2回/配布フォルダ.zip']);
    expect(await readFile(r.files[0]?.localPath ?? '', 'utf8')).toBe('PK-zip');
    expect(r.viewed).toEqual({ folder: 1 });
    expect(r.failures).toEqual([
      expect.objectContaining({ cmid: 7302, reason: expect.stringContaining('does not offer this folder as a ZIP') }),
    ]);
    expect(renderCourseDownloadLocal(r)).toContain('Opening 1 folder counted as viewing them on Moodle');
  });
});
