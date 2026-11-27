import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InvalidInput, MoodleError, MoodleUnavailable, NeedsReconnect } from '../../../src/core/errors';
import { MoodleWebSession } from '../../../src/core/moodle/web/session';
import { uploadViaRepository } from '../../../src/core/moodle/web/upload';

const BASE = 'https://wsdmoodle.waseda.jp';
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/web/${name}`, import.meta.url), 'utf8');
const EDIT = fixture('core-assign-edit-ja.html');
/** A forum view without the inline add-discussion form (no file picker): reply-only for this user. */
const FORUM_VIEW = fixture('forum-view-ja.html');
/** The file picker options a post form carries (structure as on Moodle's post.php, JSON-escaped names and URLs). */
const PICKER = `<script>M.form_filemanager.init(Y, {"path":"\\/","repositories":{"3":{"id":"3",\
"name":"\\u30d5\\u30a1\\u30a4\\u30eb\\u306e\\u30a2\\u30c3\\u30d7\\u30ed\\u30fc\\u30c9","type":"upload",\
"icon":"https:\\/\\/wsdmoodle.waseda.jp\\/theme\\/image.php\\/boost\\/repository_upload\\/1\\/icon",\
"supported_types":[],"return_types":2,"sortorder":3}},"defaultlicense":"cc-4.0"});</script>`;
const REPLY_FORM = fixture('forum-post-reply-ja.html').replace('</body>', `${PICKER}</body>`);
const SNIPPET = `<li class="activity assign modtype_assign" id="module-7001" data-for="cmitem" data-id="7001">
<a href="${BASE}/mod/assign/view.php?id=7001" class="aalink stretched-link">課題１</a></li>`;
const FORUM_SNIPPET = `<li class="activity forum modtype_forum">
<a href="${BASE}/mod/forum/view.php?id=7005">掲示板</a></li>`;

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
const page = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });

interface Sent {
  fields: Record<string, string>;
  file: File | null;
}

async function readForm(init: RequestInit): Promise<Sent> {
  const headers = init.headers as Record<string, string>;
  const form = await new Response(init.body as BodyInit, {
    headers: { 'content-type': headers['Content-Type'] ?? '' },
  }).formData();
  const fields: Record<string, string> = {};
  let file: File | null = null;
  for (const [k, v] of form.entries()) {
    if (typeof v === 'string') fields[k] = v;
    else file = v;
  }
  return { fields, file };
}

function setup(answer: (sent: Sent) => Response, snippet = SNIPPET, pages: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const handler: Handler = async (url, init) => {
    if (url.pathname === '/lib/ajax/service.php') return json([{ error: false, data: snippet }]);
    const known = pages[url.pathname + url.search];
    if (known !== undefined) return page(known);
    if (url.pathname === '/repository/repository_ajax.php') {
      const s = await readForm(init);
      sent.push(s);
      return answer(s);
    }
    if (url.pathname === '/user/preferences.php') return page(EDIT.replace('Ed1tKey777', 'Fresh0Key1'));
    return page(EDIT);
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(String(input)), init ?? {}),
  );
  const session = new MoodleWebSession({
    cookie: 'MoodleSession=abcdefghij0123456789xyz',
    sesskey: 'Key0000001',
    moodleUserId: 7001,
    baseUrl: BASE,
    fetch: fetchMock as unknown as typeof fetch,
    charge: () => {},
  });
  const paths = () => fetchMock.mock.calls.map(([u]) => new URL(String(u)).pathname + new URL(String(u)).search);
  return { session, sent, paths };
}

const success = (s: Sent) =>
  json({
    url: `${BASE}/draftfile.php/99500/user/draft/${s.fields.itemid}/${s.fields.title}`,
    id: Number(s.fields.itemid),
    file: s.fields.title,
  });
const bytes = (text: string) => new TextEncoder().encode(text);

describe('uploadViaRepository', () => {
  it('finds the activity context and upload repository, then posts the file', async () => {
    const { session, sent, paths } = setup(success);
    const out = await uploadViaRepository(
      session,
      { name: 'レポート/1.txt', body: bytes('hello'), size: 5, mime: 'text/plain' },
      { itemId: 424242, cmid: 7001 },
    );
    expect(out).toEqual({ itemid: 424242, filename: 'レポート_1.txt', filesize: 5 });
    expect(paths()).toEqual([
      '/lib/ajax/service.php?sesskey=Key0000001&info=core_course_get_module',
      '/mod/assign/view.php?id=7001&action=editsubmission',
      '/repository/repository_ajax.php?action=upload',
    ]);
    expect(sent[0]?.fields).toEqual({
      sesskey: 'Ed1tKey777', // the edit page's M.cfg refreshed the cached sesskey
      repo_id: '3',
      itemid: '424242',
      ctx_id: '88123',
      savepath: '/',
      title: 'レポート_1.txt',
      author: '',
      license: 'allrightsreserved',
    });
    expect(sent[0]?.file?.name).toBe('レポート_1.txt');
    expect(await sent[0]?.file?.text()).toBe('hello');
  });

  it('resolves the target once per session and cmid; itemId 0 -> a fresh random id', async () => {
    const { session, paths } = setup(success);
    const file = () => ({ name: 'a.txt', body: bytes('a'), size: 1 });
    const first = await uploadViaRepository(session, file(), { itemId: 0, cmid: 7001 });
    expect(first.itemid).toBeGreaterThanOrEqual(1);
    expect(first.itemid).toBeLessThanOrEqual(999_999_999);
    await uploadViaRepository(session, file(), { itemId: first.itemid, cmid: 7001 });
    expect(paths().filter((p) => p.startsWith('/repository/'))).toHaveLength(2);
    expect(paths().filter((p) => !p.startsWith('/repository/'))).toHaveLength(2);
  });

  it('streams a ReadableStream body', async () => {
    const { session, sent } = setup(success);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes('str'));
        c.enqueue(bytes('eam'));
        c.close();
      },
    });
    await uploadViaRepository(session, { name: 's.bin', body, size: 6 }, { itemId: 5, cmid: 7001 });
    expect(await sent[0]?.file?.text()).toBe('stream');
  });

  it('uses the activity page of other modules (forum view)', async () => {
    const { session, paths } = setup(success, FORUM_SNIPPET);
    await uploadViaRepository(session, { name: 'a.txt', body: bytes('a'), size: 1 }, { itemId: 9, cmid: 7005 });
    expect(paths()[1]).toBe('/mod/forum/view.php?id=7005');
  });

  it('a duplicate name -> MoodleError fileexists', async () => {
    const { session } = setup(() => json({ event: 'fileexists', newfile: { filename: 'a (1).txt' } }));
    const file = { name: 'a.txt', body: bytes('a'), size: 1 };
    const e = await uploadViaRepository(session, file, { itemId: 9, cmid: 7001 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MoodleError);
    expect((e as MoodleError).errorcode).toBe('fileexists');
    expect((e as MoodleError).message).toMatch(/already in the draft/);
  });

  it('a repository error -> MoodleError with its code', async () => {
    const { session } = setup(() => json({ error: 'The file is too big.', errorcode: 'maxbytes' }));
    await expect(
      uploadViaRepository(session, { name: 'a.txt', body: bytes('a'), size: 1 }, { itemId: 9, cmid: 7001 }),
    ).rejects.toMatchObject({ errorcode: 'maxbytes', message: 'The file is too big.' });
  });

  it('a refused sesskey: renewed, a buffered file is sent again, a stream is not', async () => {
    const refuse = (s: Sent) =>
      s.fields.sesskey === 'Ed1tKey777' ? json({ error: 'Invalid sesskey', errorcode: 'invalidsesskey' }) : success(s);
    const buffered = setup(refuse);
    const out = await uploadViaRepository(
      buffered.session,
      { name: 'a.txt', body: bytes('a'), size: 1 },
      { itemId: 9, cmid: 7001 },
    );
    expect(out.itemid).toBe(9);
    expect(buffered.sent.map((s) => s.fields.sesskey)).toEqual(['Ed1tKey777', 'Fresh0Key1']);
    const streamed = setup(refuse);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes('a'));
        c.close();
      },
    });
    await expect(
      uploadViaRepository(streamed.session, { name: 'a.txt', body, size: 1 }, { itemId: 9, cmid: 7001 }),
    ).rejects.toBeInstanceOf(MoodleUnavailable);
  });

  it('an activity without an upload repository -> MoodleError; a nameless file -> InvalidInput', async () => {
    const { session } = setup(success, `<li class="activity"></li>`);
    await expect(
      uploadViaRepository(session, { name: 'a.txt', body: bytes('a'), size: 1 }, { itemId: 9, cmid: 7001 }),
    ).rejects.toMatchObject({ errorcode: 'invalidrecord' });
    await expect(
      uploadViaRepository(session, { name: '  ', body: bytes('a'), size: 1 }, { itemId: 9, cmid: 7001 }),
    ).rejects.toBeInstanceOf(InvalidInput);
  });

  it('a forum view without a file picker: the reply form of its latest post serves (the repository is site-wide)', async () => {
    // a reply-only forum: the view has no inline add-discussion form
    const view = FORUM_VIEW.replace(/<form[^>]*post\.php[\s\S]*?<\/form>/g, '');
    const pages = { '/mod/forum/view.php?id=7005': view, '/mod/forum/post.php?reply=9105': REPLY_FORM };
    const { session, sent, paths } = setup(success, FORUM_SNIPPET, pages);
    await uploadViaRepository(session, { name: 'a.txt', body: bytes('a'), size: 1 }, { itemId: 9, cmid: 7005 });
    expect(paths().slice(1)).toEqual([
      '/mod/forum/view.php?id=7005',
      '/mod/forum/post.php?reply=9105',
      '/repository/repository_ajax.php?action=upload',
    ]);
    // the activity's context (view page), the repository and licence of the form
    expect(sent[0]?.fields).toMatchObject({ ctx_id: '8201', repo_id: '3', license: 'cc-4.0' });
  });

  it('a file picker page this session already read is reused without another request', async () => {
    const pages = { '/mod/forum/view.php?id=7005': FORUM_VIEW, '/mod/forum/post.php?edit=9200': REPLY_FORM };
    const { session, sent, paths } = setup(success, FORUM_SNIPPET, pages);
    await session.page('/mod/forum/post.php?edit=9200');
    await uploadViaRepository(session, { name: 'a.txt', body: bytes('a'), size: 1 }, { itemId: 9, cmid: 7005 });
    expect(paths().filter((p) => p.startsWith('/mod/forum/post.php'))).toEqual(['/mod/forum/post.php?edit=9200']);
    expect(sent[0]?.fields).toMatchObject({ ctx_id: '8201', repo_id: '3' });
  });

  it('a forum without any post form for the user -> nopermissiontoaccess', async () => {
    const empty = fixture('forum-news-empty-ja.html');
    const { session, sent } = setup(success, FORUM_SNIPPET, { '/mod/forum/view.php?id=7005': empty });
    await expect(
      uploadViaRepository(session, { name: 'a.txt', body: bytes('a'), size: 1 }, { itemId: 9, cmid: 7005 }),
    ).rejects.toMatchObject({ errorcode: 'nopermissiontoaccess' });
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['servicerequireslogin', () => json({ error: 'Login', errorcode: 'servicerequireslogin' })],
    ['requireloginerror', () => json({ error: 'Login', errorcode: 'requireloginerror' })],
    ['the login page', () => page(fixture('core-login-ja.html'))],
  ])('the repository answers %s: the session ends (NeedsReconnect), not counted as sent', async (_n, answer) => {
    const { session } = setup(answer);
    await expect(
      uploadViaRepository(session, { name: 'a.txt', body: bytes('a'), size: 1 }, { itemId: 9, cmid: 7001 }),
    ).rejects.toBeInstanceOf(NeedsReconnect);
    expect(session.writesSent).toBe(0);
    await expect(session.page('/my/')).rejects.toBeInstanceOf(NeedsReconnect);
  });

  it('an upload that reached Moodle counts in writesSent', async () => {
    const { session } = setup(success);
    await uploadViaRepository(session, { name: 'a.txt', body: bytes('a'), size: 1 }, { itemId: 9, cmid: 7001 });
    expect(session.writesSent).toBe(1);
  });
});
