import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CallHint } from '../../../../src/core/context';
import { MoodleError } from '../../../../src/core/errors';
import { forumCmidOf, forumFunctions, forumInstanceOf } from '../../../../src/core/moodle/web/adapters/forum';
import type { WebPage, WebRequest, WebSession } from '../../../../src/core/moodle/web/types';
import { makeFakeWebSession } from '../../../helpers/fake-web-session';

const BASE = 'https://wsdmoodle.waseda.jp';
const fixture = (name: string) => readFileSync(join(__dirname, '../../../fixtures/web', name), 'utf8');

/** Unix seconds of a Tokyo wall-clock time. */
const jst = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - 9, mi) / 1000;

const VIEW = fixture('forum-view-ja.html');
const VIEW_P2 = fixture('forum-view-page2-ja.html');
const NEWS_EN = fixture('forum-news-en.html');
const NEWS_EMPTY = fixture('forum-news-empty-ja.html');
const OVERVIEW = fixture('forum-overview-ja.html');
const POST_NEW = fixture('forum-post-new-ja.html');
const POST_EDIT = fixture('forum-post-edit-en.html');
const POST_REPLY = fixture('forum-post-reply-ja.html');
const POST_REPLY_OWN = fixture('forum-post-reply-own-en.html');
const POST_DELETE = fixture('forum-post-delete-ja.html');
const POST_INVALID = fixture('forum-post-invalid-en.html');

const OVERVIEW_PATH = '/course/overview.php?id=99101&expand[]=forum';

function run(web: WebSession, fn: string, params: Record<string, unknown>, hint: CallHint = {}): Promise<unknown> {
  const adapter = forumFunctions[fn];
  if (!adapter) throw new Error(`no adapter for ${fn}`);
  return adapter(web, params, hint);
}

type Forum = Record<string, unknown>;
type Discussion = Record<string, unknown>;
const forums = (res: unknown) => res as Forum[];
const discussions = (res: unknown) => (res as { discussions: Discussion[] }).discussions;
type OnePost = { post: Record<string, unknown> };

/** A form POST answered like Moodle: 303 to `location`, or the re-rendered page. */
function poster(answer: { location?: string; html?: string }, seen: URLSearchParams[]) {
  return (req: WebRequest): WebPage => {
    if (req.method !== 'POST' || !req.form) throw new Error('expected a POST');
    seen.push(req.form);
    if (answer.location) return { url: `${BASE}/mod/forum/post.php`, status: 303, html: '', location: answer.location };
    return { url: `${BASE}/mod/forum/post.php`, status: 200, html: answer.html ?? '', location: null };
  };
}

// ------------------------------------------------------------------ forums

describe('mod_forum_get_forums_by_courses', () => {
  it('lists every forum of a course from one overview page (real ids, counts, tracking, subscriptions)', async () => {
    const web = makeFakeWebSession({ pages: { [OVERVIEW_PATH]: OVERVIEW } });
    const list = forums(await run(web, 'mod_forum_get_forums_by_courses', { courseids: [99101] }));
    expect(web.calls).toEqual([`GET ${OVERVIEW_PATH}`]);
    expect(list.map((f) => [f.id, f.cmid, f.course, f.numdiscussions, f.istracked, f.forcesubscribe])).toEqual([
      [7103, 7003, 99101, 0, false, 1],
      [7101, 7001, 99101, 4, true, 0],
      [7105, 7005, 99101, 12, undefined, 3],
    ]);
    expect(list[1]).toMatchObject({ name: 'グループ討論', type: undefined, duedate: undefined, intro: '' });
  });

  it('one forum (hint cmid) costs its view page: type, intro, due date, add-discussion right', async () => {
    const web = makeFakeWebSession({ pages: { '/mod/forum/view.php?id=7001': VIEW } });
    const list = forums(await run(web, 'mod_forum_get_forums_by_courses', { courseids: [99101] }, { cmid: 7001 }));
    expect(web.calls).toEqual(['GET /mod/forum/view.php?id=7001']);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 7101,
      cmid: 7001,
      course: 99101,
      type: 'general',
      name: 'グループ討論',
      duedate: jst(2026, 10, 8, 23, 59),
      cancreatediscussions: true,
      forcesubscribe: 0,
    });
    expect(String(list[0]?.intro)).toContain('<b>議事録</b>');
  });

  it('detects the announcements forum by its page and takes an empty one’s id from the overview', async () => {
    const web = makeFakeWebSession({
      pages: { '/mod/forum/view.php?id=7003': NEWS_EMPTY, [OVERVIEW_PATH]: OVERVIEW },
    });
    const list = forums(await run(web, 'mod_forum_get_forums_by_courses', { courseids: [99101] }, { cmid: 7003 }));
    expect(list[0]).toMatchObject({ id: 7103, type: 'news', cancreatediscussions: false, forcesubscribe: 1 });
    expect(web.calls).toEqual(['GET /mod/forum/view.php?id=7003', `GET ${OVERVIEW_PATH}`]);
  });

  it('enriches the course list with pages already read in the session', async () => {
    const web = makeFakeWebSession({
      pages: {
        '/mod/forum/view.php?id=7001': VIEW,
        [OVERVIEW_PATH]: OVERVIEW,
        '/mod/forum/post.php?forum=7101': POST_NEW,
      },
    });
    await run(web, 'mod_forum_can_add_discussion', { forumid: 7101 });
    expect(await forumInstanceOf(web, 7001, 99101)).toBe(7101);
    const list = forums(await run(web, 'mod_forum_get_forums_by_courses', { courseids: [99101] }));
    expect(list.find((f) => f.cmid === 7001)).toMatchObject({
      type: 'general',
      duedate: jst(2026, 10, 8, 23, 59),
      maxattachments: 9,
      maxbytes: 52428800,
      istracked: true,
    });
  });

  it('a hinted cmid of another module type is no forum of the course', async () => {
    const web = makeFakeWebSession({ pages: {} });
    expect(await run(web, 'mod_forum_get_forums_by_courses', { courseids: [99101] }, { cmid: 7009 })).toEqual([]);
  });
});

// ------------------------------------------------------------------ discussions

describe('mod_forum_get_forum_discussions', () => {
  const pages = { '/mod/forum/view.php?f=7101': VIEW, '/mod/forum/view.php?f=7101&p=1': VIEW_P2 };

  it('reads the list rows: ids, subject, author, times, counts, pinned; no bodies by default', async () => {
    const web = makeFakeWebSession({ pages });
    const list = discussions(
      await run(web, 'mod_forum_get_forum_discussions', { forumid: 7101, sortorder: 1, page: 0, perpage: 3 }),
    );
    expect(web.calls).toEqual(['GET /mod/forum/view.php?f=7101']);
    expect(list.map((d) => d.discussion)).toEqual([8003, 8001, 8002]);
    expect(list[0]).toMatchObject({
      id: null,
      subject: '【重要】発表の順番 & 日程',
      userfullname: '山田太郎',
      created: jst(2026, 10, 1, 9, 0),
      timemodified: jst(2026, 10, 3, 12, 30),
      numreplies: 2,
      numunread: 1,
      pinned: true,
      message: null,
    });
    // no replies: the latest post is the first post
    expect(list[2]).toMatchObject({ id: 9102, numreplies: 0, numunread: 0, pinned: false });
  });

  it('sorts by creation (pinned first) and pages through Moodle pages', async () => {
    const web = makeFakeWebSession({ pages });
    const created = discussions(
      await run(web, 'mod_forum_get_forum_discussions', { forumid: 7101, sortorder: 3, page: 0, perpage: 10 }),
    );
    expect(created.map((d) => d.discussion)).toEqual([8003, 8002, 8001, 7990]);
    expect(web.calls).toEqual(['GET /mod/forum/view.php?f=7101', 'GET /mod/forum/view.php?f=7101&p=1']);
    const second = discussions(
      await run(web, 'mod_forum_get_forum_discussions', { forumid: 7101, sortorder: -1, page: 1, perpage: 3 }),
    );
    expect(second.map((d) => d.discussion)).toEqual([7990]);
  });

  it('reuses the view page read by cmid', async () => {
    const web = makeFakeWebSession({ pages: { '/mod/forum/view.php?id=7001': VIEW } });
    expect(await forumInstanceOf(web, 7001, 99101)).toBe(7101);
    await run(web, 'mod_forum_get_forum_discussions', { forumid: 7101, sortorder: 1, page: 0, perpage: 2 });
    expect(web.calls).toEqual(['GET /mod/forum/view.php?id=7001']);
  });

  it('adds first posts (message, exact created, first post id) with the hint, in one ajax tick', async () => {
    const web = makeFakeWebSession({
      pages: { '/mod/forum/view.php?f=7102': NEWS_EN },
      ajax: {
        mod_forum_get_discussion_posts: (args: Record<string, unknown>) => {
          if (args.discussionid !== 8101) throw new MoodleError('nope', 'invalidrecord');
          return {
            posts: [
              { id: 9201, hasparent: false, message: '<p>Due 10 October</p>', timecreated: jst(2026, 10, 2, 13, 5) },
            ],
          };
        },
      },
    });
    const hint = { messages: true } as CallHint & { messages: boolean };
    const list = discussions(
      await run(web, 'mod_forum_get_forum_discussions', { forumid: 7102, sortorder: 3, page: 0, perpage: 10 }, hint),
    );
    expect(list[0]).toMatchObject({
      id: 9201,
      discussion: 8101,
      subject: 'Report deadline',
      userfullname: 'Taro Yamada',
      message: '<p>Due 10 October</p>',
      created: jst(2026, 10, 2, 13, 5),
      timemodified: jst(2026, 10, 2, 13, 10),
    });
  });

  it('an empty forum lists nothing', async () => {
    const web = makeFakeWebSession({ pages: { '/mod/forum/view.php?f=7103': NEWS_EMPTY } });
    const list = discussions(
      await run(web, 'mod_forum_get_forum_discussions', { forumid: 7103, sortorder: 1, page: 0, perpage: 10 }),
    );
    expect(list).toEqual([]);
  });
});

// ------------------------------------------------------------------ one post

describe('mod_forum_get_discussion_post', () => {
  it('reads an own post from its edit form, the author from the reply page (raw text, ids, draft files)', async () => {
    const web = makeFakeWebSession({
      moodleUserId: 4242,
      pages: { '/mod/forum/post.php?edit=9102': POST_EDIT, '/mod/forum/post.php?reply=9102': POST_REPLY_OWN },
    });
    const res = (await run(web, 'mod_forum_get_discussion_post', { postid: 9102 })) as OnePost;
    expect(web.calls).toEqual(['GET /mod/forum/post.php?edit=9102', 'GET /mod/forum/post.php?reply=9102']);
    expect(res.post).toMatchObject({
      id: 9102,
      discussionid: 8002,
      hasparent: true,
      parentid: 9101,
      subject: 'Re: Week 3 minutes & notes',
      message: '<p>Here are our <b>notes</b>.</p>',
      author: { id: 4242, fullname: 'Taro Yamada' },
      timecreated: jst(2026, 10, 2, 9, 15),
      capabilities: { reply: true, edit: true, delete: true, controlreadstatus: false },
    });
    expect(res.post.attachments).toEqual([
      {
        filename: 'minutes.pdf',
        filepath: '/',
        filesize: 12345,
        fileurl: `${BASE}/draftfile.php/9001/user/draft/555012/minutes.pdf`,
        mimetype: 'application/pdf',
      },
    ]);
  });

  it('an edit form (mod/forum:editanypost) does not make the post the user’s: the rendered author counts', async () => {
    const reply = POST_REPLY_OWN.replace('user/view.php?id=4242', 'user/view.php?id=5555');
    const web = makeFakeWebSession({
      moodleUserId: 4242,
      pages: { '/mod/forum/post.php?edit=9102': POST_EDIT, '/mod/forum/post.php?reply=9102': reply },
    });
    const res = (await run(web, 'mod_forum_get_discussion_post', { postid: 9102 })) as OnePost;
    expect(res.post.author).toEqual({ id: 5555, fullname: 'Taro Yamada' });
  });

  it('leaves the author unknown when the reply page is refused', async () => {
    const web = makeFakeWebSession({ moodleUserId: 4242, pages: { '/mod/forum/post.php?edit=9102': POST_EDIT } });
    const res = (await run(web, 'mod_forum_get_discussion_post', { postid: 9102 })) as OnePost;
    expect(res.post.author).toEqual({ id: undefined, fullname: undefined });
    expect(res.post.capabilities).toMatchObject({ edit: true });
  });

  it('keeps the edit form’s attachment manager for the forum (access information needs no other page)', async () => {
    const web = makeFakeWebSession({
      moodleUserId: 4242,
      pages: { '/mod/forum/post.php?edit=9102': POST_EDIT, '/mod/forum/post.php?reply=9102': POST_REPLY_OWN },
    });
    await run(web, 'mod_forum_get_discussion_post', { postid: 9102 });
    const before = web.calls.length;
    expect(await run(web, 'mod_forum_get_forum_access_information', { forumid: 7101 })).toMatchObject({
      cancreateattachment: true,
    });
    expect(web.calls).toHaveLength(before);
  });

  it("reads someone else's post from the reply form, which shows it", async () => {
    const web = makeFakeWebSession({ pages: { '/mod/forum/post.php?reply=9105': POST_REPLY } });
    const res = (await run(web, 'mod_forum_get_discussion_post', { postid: 9105 })) as OnePost;
    expect(web.calls).toEqual(['GET /mod/forum/post.php?edit=9105', 'GET /mod/forum/post.php?reply=9105']);
    expect(res.post).toMatchObject({
      id: 9105,
      discussionid: 8003,
      subject: '発表の順番について',
      author: { id: 5555, fullname: '佐藤花子' },
      timecreated: jst(2026, 10, 3, 12, 30),
      capabilities: { reply: true, edit: false, delete: false },
    });
    expect(String(res.post.message)).toContain('<b>くじ</b>');
  });

  it('a post that is neither editable nor answerable is a Moodle error', async () => {
    const web = makeFakeWebSession({ pages: {} });
    await expect(run(web, 'mod_forum_get_discussion_post', { postid: 1 })).rejects.toBeInstanceOf(MoodleError);
  });
});

// ------------------------------------------------------------------ rights

describe('rights from the new-discussion form', () => {
  it('can add, with attachments, when the form opens', async () => {
    const web = makeFakeWebSession({ pages: { '/mod/forum/post.php?forum=7101': POST_NEW } });
    expect(await run(web, 'mod_forum_can_add_discussion', { forumid: 7101 })).toMatchObject({
      status: true,
      cancreateattachment: true,
    });
    expect(await run(web, 'mod_forum_get_forum_access_information', { forumid: 7101 })).toEqual({
      cancreateattachment: true,
      warnings: [],
    });
    expect(web.calls).toEqual(['GET /mod/forum/post.php?forum=7101']);
  });

  it('cannot add when Moodle refuses the form; access information is then unknown', async () => {
    const web = makeFakeWebSession({ pages: {} });
    expect(await run(web, 'mod_forum_can_add_discussion', { forumid: 7103 })).toMatchObject({ status: false });
    expect(await run(web, 'mod_forum_get_forum_access_information', { forumid: 7103 })).toEqual({ warnings: [] });
  });
});

// ------------------------------------------------------------------ writes

describe('mod_forum_add_discussion', () => {
  it('fills the form (subject, HTML message, subscription, attachments draft) and reads the new id', async () => {
    const seen: URLSearchParams[] = [];
    const post = poster({ location: `${BASE}/mod/forum/discuss.php?d=8010` }, seen);
    const web = makeFakeWebSession({
      pages: { '/mod/forum/post.php?forum=7101': POST_NEW, '/mod/forum/post.php': post },
    });
    const res = await run(web, 'mod_forum_add_discussion', {
      forumid: 7101,
      subject: 'テスト投稿',
      message: '<p>こんにちは</p>',
      options: [
        { name: 'discussionsubscribe', value: false },
        { name: 'attachmentsid', value: 777001 },
      ],
    });
    expect(res).toEqual({ discussionid: 8010, warnings: [] });
    const body = seen[0];
    expect(body?.get('subject')).toBe('テスト投稿');
    expect(body?.get('message[text]')).toBe('<p>こんにちは</p>');
    expect(body?.get('message[format]')).toBe('1');
    expect(body?.get('attachments')).toBe('777001');
    expect(body?.has('discussionsubscribe')).toBe(false);
    expect(body?.get('forum')).toBe('7101');
    expect(body?.get('sesskey')).toBe('Fx0sesskey');
    expect(body?.get('submitbutton')).toBe('フォーラムに投稿する');
    expect(body?.getAll('tags[]')).toEqual([]);
    expect(body?.has('cancel')).toBe(false);
  });

  it('finds the new discussion in the forum list when Moodle redirects to the forum', async () => {
    const post = poster({ location: `${BASE}/mod/forum/view.php?f=7101` }, []);
    const web = makeFakeWebSession({
      pages: {
        '/mod/forum/post.php?forum=7101': POST_NEW,
        '/mod/forum/post.php': post,
        '/mod/forum/view.php?f=7101': VIEW,
      },
    });
    const res = await run(web, 'mod_forum_add_discussion', { forumid: 7101, subject: '第3週の議事録', message: 'x' });
    expect(res).toEqual({ discussionid: 8002, warnings: [] });
  });

  it('a re-rendered form is a validation error with its messages', async () => {
    const web = makeFakeWebSession({
      pages: { '/mod/forum/post.php?forum=7101': POST_NEW, '/mod/forum/post.php': poster({ html: POST_INVALID }, []) },
    });
    const err = await run(web, 'mod_forum_add_discussion', { forumid: 7101, subject: '', message: 'x' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MoodleError);
    expect((err as MoodleError).message).toBe('- Required');
  });
});

describe('mod_forum_update_discussion_post', () => {
  it('changes only what is given and keeps tags and the current draft', async () => {
    const seen: URLSearchParams[] = [];
    const answer = poster({ location: `${BASE}/mod/forum/discuss.php?d=8002#p9102` }, seen);
    const web = makeFakeWebSession({
      pages: { '/mod/forum/post.php?edit=9102': POST_EDIT, '/mod/forum/post.php': answer },
    });
    const res = await run(web, 'mod_forum_update_discussion_post', {
      postid: 9102,
      subject: '',
      message: '<p>New text</p>',
      messageformat: 1,
      options: [{ name: 'discussionsubscribe', value: true }],
    });
    expect(res).toEqual({ status: true, warnings: [] });
    const body = seen[0];
    expect(body?.get('subject')).toBe('Re: Week 3 minutes & notes');
    expect(body?.get('message[text]')).toBe('<p>New text</p>');
    expect(body?.get('edit')).toBe('9102');
    expect(body?.get('attachments')).toBe('555012');
    expect(body?.get('discussionsubscribe')).toBe('1');
    expect(body?.getAll('tags[]')).toEqual(['a', 'b']);
    expect(web.calls).toEqual(['GET /mod/forum/post.php?edit=9102', 'POST /mod/forum/post.php']);
  });
});

describe('mod_forum_delete_post', () => {
  it('posts the confirmation form', async () => {
    const seen: URLSearchParams[] = [];
    const web = makeFakeWebSession({
      pages: {
        '/mod/forum/post.php?delete=9102': POST_DELETE,
        '/mod/forum/post.php': poster({ location: `${BASE}/mod/forum/discuss.php?d=8002` }, seen),
      },
    });
    expect(await run(web, 'mod_forum_delete_post', { postid: 9102 })).toEqual({ status: true, warnings: [] });
    expect(seen[0] && Object.fromEntries(seen[0])).toEqual({ delete: '9102', confirm: '9102', sesskey: 'Fx0sesskey' });
  });

  it('refuses without a confirmation on the page', async () => {
    const web = makeFakeWebSession({ pages: { '/mod/forum/post.php?delete=9102': VIEW } });
    await expect(run(web, 'mod_forum_delete_post', { postid: 9102 })).rejects.toBeInstanceOf(MoodleError);
  });
});

// ------------------------------------------------------------------ instance ids

describe('forumInstanceOf / forumCmidOf', () => {
  it('maps cmid → forum id from the view page and back without another request', async () => {
    const web = makeFakeWebSession({ pages: { '/mod/forum/view.php?id=7001': VIEW } });
    expect(await forumInstanceOf(web, 7001, 99101)).toBe(7101);
    expect(await forumCmidOf(web, 7101)).toBe(7001);
    expect(web.calls).toEqual(['GET /mod/forum/view.php?id=7001']);
  });

  it('forum id → cmid through view.php?f=', async () => {
    const web = makeFakeWebSession({ pages: { '/mod/forum/view.php?f=7102': NEWS_EN } });
    expect(await forumCmidOf(web, 7102)).toBe(7002);
  });

  it('hsuforum: the id from the activity page links', async () => {
    const web = makeFakeWebSession({ pages: { '/mod/hsuforum/view.php?id=7201': fixture('forum-hsu-view-ja.html') } });
    expect(await forumInstanceOf(web, 7201, 99103, 'hsuforum')).toBe(7301);
  });
});

// ------------------------------------------------------------------ hsuforum

describe('mod_hsuforum reads', () => {
  const HSU_INDEX = fixture('forum-hsu-index-ja.html');
  const state = JSON.stringify({
    cm: [
      { id: '7201', name: 'アナウンスメント/Announcement', module: 'hsuforum' },
      { id: '7202', name: '教室と時間', module: 'hsuforum' },
      { id: '7203', name: 'Week 1', module: 'page' },
    ],
  });

  it('lists the course forums from the index with cmids by name', async () => {
    const web = makeFakeWebSession({
      pages: { '/mod/hsuforum/index.php?id=99103': HSU_INDEX },
      ajax: { core_courseformat_get_state: state },
    });
    const list = forums(await run(web, 'mod_hsuforum_get_forums_by_courses', { courseids: [99103] }));
    expect(list.map((f) => [f.id, f.cmid, f.name, f.numdiscussions])).toEqual([
      [7301, 7201, 'アナウンスメント/Announcement', 3],
      [7302, 7202, '教室と時間', 0],
    ]);
    expect(String(list[1]?.intro)).toContain('22-502');
  });

  it('lists discussions and posts (nested replies keep their parent)', async () => {
    const web = makeFakeWebSession({
      pages: {
        '/mod/hsuforum/view.php?f=7301': fixture('forum-hsu-view-ja.html'),
        '/mod/hsuforum/discuss.php?d=8401': fixture('forum-hsu-discuss-ja.html'),
      },
    });
    const list = discussions(
      await run(web, 'mod_hsuforum_get_forum_discussions_paginated', { forumid: 7301, page: 0, perpage: 10 }),
    );
    expect(list.map((d) => [d.discussion, d.id, d.subject, d.userfullname])).toEqual([
      [8401, 9401, '教室変更のお知らせ', '山田太郎'],
      [8402, 9402, 'Syllabus', 'Taro Yamada'],
    ]);
    expect(list[0]?.created).toBe(jst(2026, 10, 2, 9, 30));
    const posts = (await run(web, 'mod_hsuforum_get_forum_discussion_posts', { discussionid: 8401 })) as {
      posts: Record<string, unknown>[];
    };
    expect(posts.posts.map((p) => [p.id, p.parent, p.subject, p.userfullname, p.canreply])).toEqual([
      [9401, 0, '教室変更のお知らせ', '山田太郎', true],
      [9410, 9401, 'Re: 教室変更のお知らせ', 'alice', false],
      [9411, 9410, 'Re: 了解', '山田太郎', false],
    ]);
    expect(String(posts.posts[0]?.message)).toContain('<b>22-502</b>');
  });

  it('has no write functions (the services refuse Advanced Forum posts on the web channel)', () => {
    const writes = Object.keys(forumFunctions).filter((k) => /^mod_hsuforum_.*(add|update|delete)/.test(k));
    expect(writes).toEqual([]);
  });
});
