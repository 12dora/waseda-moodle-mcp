import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileLink } from '../../src/core/services/files';
import { BASE_URL, createTestContext } from '../helpers/fake-context-be4';

const PATH = '/webservice/pluginfile.php/11/mod_resource/content/0/notes.txt';
const FILE_URL = `${BASE_URL}${PATH}`;
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

describe('stdio local copy', () => {
  it('reuses the inline bytes instead of downloading a second time', async () => {
    const t = createTestContext({ mode: 'stdio' });
    t.moodle.files.set(FILE_URL, { body: 'hello notes', contentType: 'text/plain' });
    const link = await createFileLink(t.ctx, FILE_URL, { inline: true });
    expect(link.inline).toEqual({ mime: 'text/plain', text: 'hello notes' });
    expect(t.moodle.fetched.map((f) => f.method)).toEqual(['HEAD', 'GET']);
    expect(await readFile(fileURLToPath(link.downloadUrl), 'utf8')).toBe('hello notes');
  });

  it('does not copy files over 50 MB and returns a browser address instead', async () => {
    const t = createTestContext({ mode: 'stdio' });
    t.moodle.files.set(FILE_URL, { body: 'x', contentType: 'application/pdf' });
    const real = t.moodle.fetchFile.bind(t.moodle);
    t.moodle.fetchFile = async (url, init) => {
      const res = await real(url, init);
      const headers = new Headers(res.headers);
      headers.set('content-length', String(60 * MB));
      return new Response(res.body, { status: res.status, headers });
    };
    const link = await createFileLink(t.ctx, FILE_URL);
    expect(link.downloadUrl).toBe(`${BASE_URL}/pluginfile.php/11/mod_resource/content/0/notes.txt`);
    expect(t.moodle.fetched.map((f) => f.method)).toEqual(['HEAD']);
    expect(await readdir(tmp)).toEqual([]);
  });

  it('stops a download that turns out bigger than 50 MB and leaves no file behind', async () => {
    const t = createTestContext({ mode: 'stdio' });
    t.moodle.files.set(FILE_URL, { body: 'x', contentType: 'application/pdf' });
    const real = t.moodle.fetchFile.bind(t.moodle);
    t.moodle.fetchFile = async (url, init) => {
      if (init?.method === 'HEAD') {
        const head = await real(url, init);
        const headers = new Headers(head.headers);
        headers.delete('content-length'); // size unknown up front
        return new Response(null, { status: 200, headers });
      }
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 55) return controller.close();
          sent++;
          controller.enqueue(new Uint8Array(MB));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/pdf' } });
    };
    const link = await createFileLink(t.ctx, FILE_URL);
    expect(link.downloadUrl.startsWith('https://')).toBe(true);
    expect(await readdir(tmp)).toEqual([]);
  });

  it('removes wmm-* download folders older than a day, and only those', async () => {
    const old = join(tmp, 'wmm-abc123');
    const fresh = join(tmp, 'wmm-def456');
    const other = join(tmp, 'keep-me');
    for (const d of [old, fresh, other]) await mkdir(d);
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
    await utimes(old, twoDaysAgo, twoDaysAgo);
    await utimes(other, twoDaysAgo, twoDaysAgo);

    const t = createTestContext({ mode: 'stdio' });
    t.moodle.files.set(FILE_URL, { body: 'data', contentType: 'text/plain' });
    await createFileLink(t.ctx, FILE_URL);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});
