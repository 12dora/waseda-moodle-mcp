import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Forbidden, InvalidInput, NeedsReconnect, NotFound } from '../../src/core/errors';
import { getActivity } from '../../src/core/services/activity';
import {
  createFileLink,
  createUploadLink,
  type FileRouteEnv,
  streamDownload,
  streamUpload,
} from '../../src/core/services/files';
import { ASSIGN_CMID, makeAssign, makeSubmission } from '../fixtures/be4/assign';
import { BASE_URL, createTestContext, makeUser, PUBLIC_URL, type TestContext } from '../helpers/fake-context-be4';

vi.mock('../../src/core/services/activity', () => ({ getActivity: vi.fn() }));
const getActivityMock = vi.mocked(getActivity);

const NOW = new Date('2026-10-14T03:00:00Z'); // 12:00 JST
const PATH = '/webservice/pluginfile.php/11/mod_resource/content/0/Slides%20A.pdf';
const FILE_URL = `${BASE_URL}${PATH}`;

beforeEach(() => {
  vi.setSystemTime(NOW);
  getActivityMock.mockReset();
  getActivityMock.mockResolvedValue(makeAssign());
});
afterEach(() => {
  vi.useRealTimers();
});

const envOf = (t: TestContext, makeMoodle?: FileRouteEnv['makeMoodle']): FileRouteEnv => ({
  store: t.store,
  signer: t.signer,
  makeMoodle: makeMoodle ?? (async () => t.moodle),
});
const ticketOf = (url: string) => url.split('/').pop()!;
const bytesOf = (s: string) => new TextEncoder().encode(s);

describe('createFileLink', () => {
  it('validates, probes with HEAD and signs a 15 minute ticket without the token', async () => {
    const t = createTestContext();
    t.moodle.files.set(FILE_URL, {
      body: 'PDFDATA',
      contentType: 'application/pdf',
      contentDisposition: 'inline; filename="Slides A.pdf"',
    });
    const link = await createFileLink(
      t.ctx,
      `${BASE_URL}/pluginfile.php/11/mod_resource/content/0/Slides%20A.pdf?token=secret`,
    );

    expect(link).toMatchObject({
      name: 'Slides A.pdf',
      mime: 'application/pdf',
      size: 7,
      inline: null,
      expiresAt: '2026-10-14T12:15:00+09:00',
    });
    expect(link.downloadUrl.startsWith(`${PUBLIC_URL}/f/`)).toBe(true);
    expect(t.moodle.fetched).toEqual([{ url: FILE_URL, method: 'HEAD', range: undefined }]);
    const payload = await t.signer.verify<{ k: string; u: number; p: string; n: string }>(ticketOf(link.downloadUrl));
    expect(payload).toMatchObject({ k: 'dl', u: t.ctx.user.id, p: PATH, n: 'Slides A.pdf' });
    expect(JSON.stringify(payload)).not.toContain('secret');
    expect(t.store.auditLog.map((a) => a.action)).toEqual(['file:link']);
  });

  it('keeps other query parameters and falls back to the path for the name', async () => {
    const t = createTestContext();
    t.moodle.files.set(`${FILE_URL}?forcedownload=1`, { body: 'x', contentType: 'application/octet-stream' });
    const link = await createFileLink(t.ctx, `${FILE_URL}?forcedownload=1&token=abc`);
    expect(link.name).toBe('Slides A.pdf');
    expect(link.mime).toBe('application/pdf'); // guessed from the extension
    const payload = await t.signer.verify<{ p: string }>(ticketOf(link.downloadUrl));
    expect(payload!.p).toBe(`${PATH}?forcedownload=1`);
  });

  it('reads RFC 5987 file names', async () => {
    const t = createTestContext();
    t.moodle.files.set(FILE_URL, {
      body: 'x',
      contentDisposition: "attachment; filename*=UTF-8''%E8%B3%87%E6%96%99.pdf",
    });
    expect((await createFileLink(t.ctx, FILE_URL)).name).toBe('資料.pdf');
  });

  it('rejects foreign hosts, other paths and garbage', async () => {
    const { ctx } = createTestContext();
    await expect(
      createFileLink(ctx, 'https://evil.example.com/webservice/pluginfile.php/1/a/b/0/c.pdf'),
    ).rejects.toThrow('Only files hosted on Waseda Moodle');
    await expect(createFileLink(ctx, `${BASE_URL}/course/view.php?id=1`)).rejects.toThrow('pluginfile.php');
    await expect(
      createFileLink(ctx, `${BASE_URL}/webservice/pluginfile.php/../../admin/index.php`),
    ).rejects.toBeInstanceOf(InvalidInput);
    await expect(createFileLink(ctx, 'not a url')).rejects.toBeInstanceOf(InvalidInput);
  });

  it('maps a missing or forbidden file', async () => {
    const t = createTestContext();
    await expect(createFileLink(t.ctx, FILE_URL)).rejects.toBeInstanceOf(NotFound); // fake serves 404
    t.moodle.files.set(FILE_URL, { body: 'x', status: 403 });
    await expect(createFileLink(t.ctx, FILE_URL)).rejects.toBeInstanceOf(Forbidden);
  });

  describe('inline content', () => {
    it('returns text for small text-like files and converts html', async () => {
      const t = createTestContext();
      t.moodle.files.set(FILE_URL, { body: 'a,b\n1,2\n', contentType: 'text/csv; charset=utf-8' });
      const csv = await createFileLink(t.ctx, FILE_URL, { inline: true });
      expect(csv.inline).toEqual({ mime: 'text/csv', text: 'a,b\n1,2\n' });
      expect(t.moodle.fetched.map((f) => f.method)).toEqual(['HEAD', 'GET']);

      t.moodle.files.set(FILE_URL, { body: '<p>Hello <b>world</b></p>', contentType: 'text/html' });
      const html = await createFileLink(t.ctx, FILE_URL, { inline: true });
      expect(html.inline).toMatchObject({ mime: 'text/markdown' });
      expect((html.inline as { text: string }).text).toContain('Hello');
      expect((html.inline as { text: string }).text).not.toContain('<p>');
    });

    it('returns base64 for images and pdf', async () => {
      const t = createTestContext();
      t.moodle.files.set(FILE_URL, { body: new Uint8Array([137, 80, 78, 71]), contentType: 'image/png' });
      expect((await createFileLink(t.ctx, FILE_URL, { inline: true })).inline).toEqual({
        mime: 'image/png',
        base64: 'iVBORw==',
      });
      t.moodle.files.set(FILE_URL, { body: '%PDF', contentType: 'application/pdf' });
      expect((await createFileLink(t.ctx, FILE_URL, { inline: true })).inline).toEqual({
        mime: 'application/pdf',
        base64: btoa('%PDF'),
      });
    });

    it('skips inline for big files, other types and when not requested', async () => {
      const t = createTestContext();
      t.moodle.files.set(FILE_URL, { body: new Uint8Array(1024 * 1024 + 1), contentType: 'text/plain' });
      expect((await createFileLink(t.ctx, FILE_URL, { inline: true })).inline).toBeNull();
      t.moodle.files.set(FILE_URL, { body: 'zipdata', contentType: 'application/zip' });
      expect((await createFileLink(t.ctx, FILE_URL, { inline: true })).inline).toBeNull();
      t.moodle.files.set(FILE_URL, { body: 'text', contentType: 'text/plain' });
      t.moodle.fetched.length = 0;
      expect((await createFileLink(t.ctx, FILE_URL)).inline).toBeNull();
      expect(t.moodle.fetched.map((f) => f.method)).toEqual(['HEAD']);
    });
  });

  it('downloads to a temp file in stdio mode instead of signing a link', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const t = createTestContext({ mode: 'stdio' });
    t.moodle.files.set(FILE_URL, { body: 'LOCAL-COPY', contentType: 'application/pdf' });
    const link = await createFileLink(t.ctx, FILE_URL);
    expect(link.downloadUrl.startsWith('file://')).toBe(true);
    const file = url.fileURLToPath(link.downloadUrl);
    try {
      expect(path.basename(file)).toBe('Slides A.pdf');
      expect(await fs.readFile(file, 'utf8')).toBe('LOCAL-COPY');
    } finally {
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe('streamDownload', () => {
  async function ticket(t: TestContext, payload: Record<string, unknown> = {}, ttl = 900) {
    return t.signer.sign({ k: 'dl', u: t.ctx.user.id, p: PATH, n: 'Slides A.pdf', ...payload }, ttl);
  }
  const get = (init: RequestInit = {}) => new Request('https://svc.example.com/f/x', init);

  it('streams the upstream bytes with attachment headers', async () => {
    const t = createTestContext();
    t.moodle.files.set(FILE_URL, { body: 'PDFDATA', contentType: 'application/pdf' });
    const res = await streamDownload(envOf(t), await ticket(t), get({ headers: { range: 'bytes=0-3' } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PDFDATA');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-length')).toBe('7');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="Slides A.pdf"; filename*=UTF-8''Slides%20A.pdf`,
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(t.moodle.fetched).toEqual([{ url: FILE_URL, method: 'GET', range: 'bytes=0-3' }]);
  });

  it('encodes non-ASCII names', async () => {
    const t = createTestContext();
    t.moodle.files.set(FILE_URL, { body: 'x' });
    const res = await streamDownload(envOf(t), await ticket(t, { n: '資料 1.pdf' }), get());
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="__ 1.pdf"; filename*=UTF-8''%E8%B3%87%E6%96%99%201.pdf`,
    );
  });

  it('answers HEAD without a body', async () => {
    const t = createTestContext();
    t.moodle.files.set(FILE_URL, { body: 'PDFDATA' });
    const res = await streamDownload(envOf(t), await ticket(t), get({ method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('7');
    expect(await res.text()).toBe('');
    expect(t.moodle.fetched[0]!.method).toBe('HEAD');
  });

  it('rejects bad, expired, wrong-kind tickets and wrong methods', async () => {
    const t = createTestContext();
    t.moodle.files.set(FILE_URL, { body: 'x' });
    const env = envOf(t);
    expect((await streamDownload(env, 'garbage', get())).status).toBe(404);
    expect((await streamDownload(env, await ticket(t, {}, -5), get())).status).toBe(404);
    expect((await streamDownload(env, await ticket(t, { k: 'up' }), get())).status).toBe(404);
    expect((await streamDownload(env, await ticket(t), get({ method: 'DELETE' }))).status).toBe(405);
    expect(t.moodle.fetched).toHaveLength(0);
  });

  it('turns upstream and auth failures into JSON errors', async () => {
    const t = createTestContext();
    const env = envOf(t);
    const missing = await streamDownload(env, await ticket(t), get());
    expect(missing.status).toBe(404);
    expect((await missing.json()) as unknown).toMatchObject({ error: { code: 'not_found' } });

    t.moodle.files.set(FILE_URL, {
      body: '{"exception":"x","errorcode":"invalidtoken"}',
      contentType: 'application/json',
    });
    const jsonError = await streamDownload(env, await ticket(t), get());
    expect(jsonError.status).toBe(502);

    t.moodle.files.set(FILE_URL, { body: '{"a":1}', contentType: 'application/json' });
    const realJson = await streamDownload(env, await ticket(t, { n: 'data.json' }), get());
    expect(realJson.status).toBe(200);

    const reconnect = await streamDownload(
      envOf(t, async () => {
        throw new NeedsReconnect();
      }),
      await ticket(t),
      get(),
    );
    expect(reconnect.status).toBe(401);
  });
});

describe('createUploadLink', () => {
  it('allocates a draft, stores the upload row and signs a 30 minute ticket', async () => {
    const t = createTestContext();
    const link = await createUploadLink(t.ctx, ASSIGN_CMID);

    expect(link.draftItemId).toBe(9000);
    expect(link.maxBytes).toBe(10 * 1024 * 1024);
    expect(link.expiresAt).toBe('2026-10-14T12:30:00+09:00');
    expect(link.uploadUrl.startsWith(`${PUBLIC_URL}/u/`)).toBe(true);
    expect(link.curlExample).toBe(`curl -T ./report.pdf "${link.uploadUrl}?name=report.pdf"`);

    const row = t.store.uploads.get(link.uploadId)!;
    expect(row).toMatchObject({
      userId: t.ctx.user.id,
      cmid: ASSIGN_CMID,
      draftItemId: 9000,
      files: [],
      totalBytes: 0,
    });
    expect(row.expiresAt).toBe(NOW.getTime() + 30 * 60_000);
    const payload = await t.signer.verify(ticketOf(link.uploadUrl));
    expect(payload).toMatchObject({ k: 'up', u: t.ctx.user.id, d: link.uploadId, mb: 10 * 1024 * 1024, mf: 3 });
    expect(t.moodle.callsTo('core_files_get_unused_draft_itemid')).toHaveLength(1);
    expect(t.store.auditLog.map((a) => a.action)).toEqual(['upload:create']);
  });

  it('caps the size at 20 MiB and defaults the file count', async () => {
    getActivityMock.mockResolvedValue(makeAssign({ maxFileBytes: null, maxFiles: null }));
    const t = createTestContext();
    const link = await createUploadLink(t.ctx, ASSIGN_CMID);
    expect(link.maxBytes).toBe(20 * 1024 * 1024);
    expect(await t.signer.verify(ticketOf(link.uploadUrl))).toMatchObject({ mb: 20 * 1024 * 1024, mf: 20 });
  });

  it('enforces write permissions', async () => {
    await expect(createUploadLink(createTestContext({ scopes: ['moodle:read'] }).ctx, ASSIGN_CMID)).rejects.toThrow(
      'This connection is read-only.',
    );
    await expect(
      createUploadLink(createTestContext({ user: makeUser({ settings: { writeMode: 'off' } }) }).ctx, ASSIGN_CMID),
    ).rejects.toThrow('Write actions are turned off in settings.');
  });

  it('checks that the assignment takes files and is open', async () => {
    const t = createTestContext();
    getActivityMock.mockResolvedValue(makeAssign({ submissionTypes: ['onlinetext'] }));
    await expect(createUploadLink(t.ctx, ASSIGN_CMID)).rejects.toThrow('does not accept file submissions');
    getActivityMock.mockResolvedValue(makeAssign({ submission: makeSubmission({ locked: true }) }));
    await expect(createUploadLink(t.ctx, ASSIGN_CMID)).rejects.toThrow('locked');
    getActivityMock.mockResolvedValue({ type: 'content' } as never);
    await expect(createUploadLink(t.ctx, ASSIGN_CMID)).rejects.toThrow('not an assignment');
    expect(t.moodle.callsTo('core_files_get_unused_draft_itemid')).toHaveLength(0);
  });

  it('is not available in stdio mode', async () => {
    const t = createTestContext({ mode: 'stdio' });
    await expect(createUploadLink(t.ctx, ASSIGN_CMID)).rejects.toThrow('files[].path');
  });
});

describe('streamUpload', () => {
  async function linked(over: Parameters<typeof makeAssign>[0] = {}) {
    getActivityMock.mockResolvedValue(makeAssign(over));
    const t = createTestContext();
    const link = await createUploadLink(t.ctx, ASSIGN_CMID);
    return { t, link, ticket: ticketOf(link.uploadUrl) };
  }
  const put = (name: string | null, body: Uint8Array | null, headers: Record<string, string> = {}, method = 'PUT') =>
    new Request(`https://svc.example.com/u/x${name === null ? '' : `?name=${encodeURIComponent(name)}`}`, {
      method,
      body: body as unknown as BodyInit | null,
      headers: body ? { 'content-length': String(body.length), ...headers } : headers,
    });

  it('streams raw bytes into the draft and records the file', async () => {
    const { t, link, ticket } = await linked();
    const res = await streamUpload(
      envOf(t),
      ticket,
      put('report.pdf', bytesOf('PDF-BYTES'), { 'content-type': 'application/pdf' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      file: { name: 'report.pdf', size: 9 },
      files: [{ name: 'report.pdf', size: 9 }],
    });

    expect(t.moodle.uploads).toHaveLength(1);
    expect(t.moodle.uploads[0]).toMatchObject({
      name: 'report.pdf',
      itemId: link.draftItemId,
      mime: 'application/pdf',
      declaredSize: 9,
    });
    expect(new TextDecoder().decode(t.moodle.uploads[0]!.bytes)).toBe('PDF-BYTES');
    expect(t.store.uploads.get(link.uploadId)).toMatchObject({
      totalBytes: 9,
      files: [{ name: 'report.pdf', size: 9, mime: 'application/pdf' }],
    });
    expect(t.store.auditLog.map((a) => a.action)).toContain('upload:file');

    const second = await streamUpload(
      envOf(t),
      ticket,
      put('notes.docx', bytesOf('N'), { 'content-type': 'application/octet-stream' }, 'POST'),
    );
    expect(await second.json()).toMatchObject({ files: [{ name: 'report.pdf' }, { name: 'notes.docx' }] });
    expect(t.moodle.uploads[1]!.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('sanitizes the file name', async () => {
    const { t, ticket } = await linked();
    const res = await streamUpload(envOf(t), ticket, put('../../evil.pdf', bytesOf('x')));
    expect(((await res.json()) as { file: { name: string } }).file.name).toBe('evil.pdf');
  });

  it('requires a name, Content-Length and raw bodies', async () => {
    const { t, ticket } = await linked();
    const env = envOf(t);
    expect((await streamUpload(env, ticket, put(null, bytesOf('x')))).status).toBe(400);
    expect((await streamUpload(env, ticket, put('..', bytesOf('x')))).status).toBe(400);
    expect(
      (
        await streamUpload(
          env,
          ticket,
          new Request('https://svc.example.com/u/x?name=a.pdf', { method: 'PUT', body: bytesOf('x') }),
        )
      ).status,
    ).toBe(411);
    expect(
      (await streamUpload(env, ticket, put('a.pdf', bytesOf('x'), { 'transfer-encoding': 'chunked' }))).status,
    ).toBe(411);
    expect(
      (
        await streamUpload(
          env,
          ticket,
          put('a.pdf', bytesOf('x'), { 'content-type': 'multipart/form-data; boundary=x' }),
        )
      ).status,
    ).toBe(415);
    expect((await streamUpload(env, ticket, put('a.pdf', null))).status).toBe(411);
    expect((await streamUpload(env, ticket, put('a.pdf', new Uint8Array(0)))).status).toBe(400);
    expect((await streamUpload(env, ticket, put('a.pdf', bytesOf('x'), {}, 'PATCH'))).status).toBe(405);
    expect(t.moodle.uploads).toHaveLength(0);
  });

  it('enforces size, duplicate and count limits', async () => {
    const { t, link, ticket } = await linked({ maxFileBytes: 8, maxFiles: 2 });
    const env = envOf(t);
    expect((await streamUpload(env, ticket, put('big.pdf', bytesOf('123456789')))).status).toBe(413);
    expect((await streamUpload(env, ticket, put('a.pdf', bytesOf('1234')))).status).toBe(200);
    const dup = await streamUpload(env, ticket, put('A.PDF', bytesOf('1234')));
    expect(dup.status).toBe(409);
    expect((await streamUpload(env, ticket, put('b.pdf', bytesOf('1234')))).status).toBe(200);
    const tooMany = await streamUpload(env, ticket, put('c.pdf', bytesOf('1')));
    expect(tooMany.status).toBe(409);
    expect(t.moodle.uploads.map((u) => u.name)).toEqual(['a.pdf', 'b.pdf']);

    // total cap across the draft
    t.store.uploads.get(link.uploadId)!.files = [];
    t.store.uploads.get(link.uploadId)!.totalBytes = 50 * 1024 * 1024 - 1;
    expect((await streamUpload(env, ticket, put('d.pdf', bytesOf('12')))).status).toBe(413);
  });

  it('rejects invalid, expired and foreign tickets', async () => {
    const { t, link, ticket } = await linked();
    const env = envOf(t);
    expect((await streamUpload(env, 'garbage', put('a.pdf', bytesOf('x')))).status).toBe(404);
    expect(
      (await streamUpload(env, await t.signer.sign({ k: 'dl', u: 1, p: '/x' }, 60), put('a.pdf', bytesOf('x')))).status,
    ).toBe(404);
    expect(
      (
        await streamUpload(
          env,
          await t.signer.sign({ k: 'up', u: t.ctx.user.id, d: link.uploadId }, -1),
          put('a.pdf', bytesOf('x')),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await streamUpload(
          env,
          await t.signer.sign({ k: 'up', u: 999, d: link.uploadId }, 60),
          put('a.pdf', bytesOf('x')),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await streamUpload(
          env,
          await t.signer.sign({ k: 'up', u: t.ctx.user.id, d: 'upl_unknown' }, 60),
          put('a.pdf', bytesOf('x')),
        )
      ).status,
    ).toBe(404);
    t.store.uploads.get(link.uploadId)!.expiresAt = Date.now() - 1;
    expect((await streamUpload(env, ticket, put('a.pdf', bytesOf('x')))).status).toBe(404);
    expect(t.moodle.uploads).toHaveLength(0);
  });

  it('maps Moodle-side duplicate names to 409 and auth loss to 401', async () => {
    const { t, link, ticket } = await linked();
    t.moodle.uploads.push({
      name: 'x.pdf',
      bytes: bytesOf('old'),
      itemId: link.draftItemId,
      mime: null,
      declaredSize: 3,
    });
    expect((await streamUpload(envOf(t), ticket, put('x.pdf', bytesOf('new')))).status).toBe(409);
    expect(t.store.uploads.get(link.uploadId)!.files).toEqual([]);

    const gone = await streamUpload(
      envOf(t, async () => {
        throw new NeedsReconnect();
      }),
      ticket,
      put('y.pdf', bytesOf('y')),
    );
    expect(gone.status).toBe(401);
  });
});
