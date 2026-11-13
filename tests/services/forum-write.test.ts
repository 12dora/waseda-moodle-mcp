import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoodleError, NotFound } from '../../src/core/errors';
import {
  confirmAction,
  prepareForumPost,
  prepareForumPostChange,
  prepareMarkRead,
} from '../../src/core/services/actions';
import { getActivity } from '../../src/core/services/activity';
import { createUploadLink } from '../../src/core/services/files';
import type { ForumDetail } from '../../src/core/types';
import { BASE_URL, createTestContext, type TestContext } from '../helpers/fake-context-be4';

vi.mock('../../src/core/services/activity', () => ({ getActivity: vi.fn() }));

type Raw = Record<string, unknown>;

const NOW = new Date('2026-10-14T03:00:00Z'); // 12:00 JST
const NOW_S = NOW.getTime() / 1000;
const COURSE = 99;
const FORUM_ID = 3001;
const FORUM_CMID = 7010;
const HSU_CMID = 7020;
const ME = 1001;
const OTHER = 2002;
const MIB = 1024 * 1024;
const OLD_FILE_URL = `${BASE_URL}/webservice/pluginfile.php/1/mod_forum/attachment/77/old.pdf`;

const forumRaw = (over: Raw = {}) => ({
  id: FORUM_ID,
  cmid: FORUM_CMID,
  course: COURSE,
  type: 'general',
  name: '総合日本語３Ｘ 自己紹介',
  duedate: 0,
  cutoffdate: 0,
  maxattachments: 2,
  maxbytes: MIB,
  istracked: true,
  forcesubscribe: 0,
  ...over,
});

const post = (id: number, over: Raw = {}): Raw => ({
  id,
  subject: `Post ${id}`,
  message: `<p>Body of ${id}</p>`,
  discussionid: 55,
  hasparent: true,
  parentid: 77,
  timemodified: NOW_S - 600,
  author: { id: OTHER, fullname: 'Hanako Sato' },
  capabilities: { reply: true, edit: false, delete: false, controlreadstatus: false },
  attachments: [],
  ...over,
});

const OWN = {
  author: { id: ME, fullname: 'Taro Yamada' },
  capabilities: { reply: true, edit: true, delete: true, controlreadstatus: false },
};
const OLD_FILE = { filename: 'old.pdf', fileurl: OLD_FILE_URL, filesize: 3, mimetype: 'application/pdf' };

interface Site {
  posts: Raw[];
  unread: Set<number>;
  /** Discussion subscription as Moodle's forum_post_subscription leaves it. */
  subscribed: boolean;
}

/**
 * Discussion 55 (first post 77 → 78 → 79) in forum 3001 (cmid 7010) of course 99. Models Moodle's side effects:
 * mod_forum_get_discussion_posts marks the returned posts read (tracked forum, automatic marking),
 * update_discussion_post unsubscribes unless discussionsubscribe is sent as true, and delete_post refuses a post
 * with replies without mod/forum:deleteanypost.
 */
function forumSite(
  t: TestContext,
  opts: { forum?: Raw; posts?: Raw[]; unread?: number[]; access?: Raw | null } = {},
): Site {
  const site: Site = {
    posts: opts.posts ?? [
      post(77, { subject: '自己紹介', hasparent: false, parentid: null }),
      post(78, { parentid: 77 }),
      post(79, { parentid: 78 }),
    ],
    unread: new Set(opts.unread ?? [79]),
    subscribed: true,
  };
  const h = t.moodle.handlers;
  h.core_course_get_course_module = (p: Raw) => {
    if (p.cmid === FORUM_CMID) return { cm: { course: COURSE, modname: 'forum', instance: FORUM_ID, name: 'x' } };
    if (p.cmid === HSU_CMID) return { cm: { course: COURSE, modname: 'hsuforum', instance: 4, name: 'y' } };
    throw new Error('unknown cmid');
  };
  h.core_course_get_course_module_by_instance = { cm: { id: FORUM_CMID, course: COURSE, name: 'x' } };
  h.mod_forum_get_forums_by_courses = [forumRaw(opts.forum)];
  h.mod_forum_can_add_discussion = { status: true, cancreateattachment: true, warnings: [] };
  if (opts.access !== null) {
    h.mod_forum_get_forum_access_information = { cancreateattachment: true, candeleteanypost: false, ...opts.access };
  }
  h.mod_forum_get_forum_discussions = () => ({
    discussions: [{ id: 77, discussion: 55, numreplies: site.posts.length - 1, numunread: site.unread.size }],
  });
  h.mod_forum_get_discussion_post = (p: Raw) => {
    const found = site.posts.find((x) => x.id === p.postid);
    if (!found) throw new Error('invalidpostid');
    return { post: { ...found, unread: site.unread.has(found.id as number) }, warnings: [] };
  };
  h.mod_forum_get_discussion_posts = () => {
    const posts = site.posts.map((x) => ({ ...x, unread: site.unread.has(x.id as number) }));
    site.unread.clear(); // automatic read marking
    return { posts, forumid: FORUM_ID, courseid: COURSE, warnings: [] };
  };
  h.mod_forum_update_discussion_post = (p: Raw) => {
    const options = (p.options as Raw[] | undefined) ?? [];
    site.subscribed = options.some((o) => o.name === 'discussionsubscribe' && o.value === true);
    return { status: true, warnings: [] };
  };
  h.mod_forum_delete_post = (p: Raw) => {
    if (opts.access?.candeleteanypost !== true && site.posts.some((x) => x.parentid === p.postid)) {
      throw new MoodleError('You cannot delete a post that has replies.', 'couldnotdeletereplies');
    }
    return { status: true, warnings: [] };
  };
  return site;
}

const ownPosts = (over: Raw = {}) => [
  post(77, { subject: '自己紹介', hasparent: false, parentid: null }),
  post(80, { ...OWN, subject: 'My answer', parentid: 77, attachments: [OLD_FILE], ...over }),
];

beforeEach(() => {
  vi.setSystemTime(NOW);
  vi.mocked(getActivity).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------------ new posts

describe('prepareForumPost: permission checks fail closed', () => {
  it('refuses a new discussion where Moodle says the user cannot add one', async () => {
    const t = createTestContext();
    forumSite(t);
    t.moodle.handlers.mod_forum_can_add_discussion = { status: false, warnings: [] };
    await expect(
      prepareForumPost(t.ctx, { forumType: 'forum', forumId: FORUM_ID, subject: 'Hi', message: 'x' }),
    ).rejects.toThrow("You can't start a discussion in this forum");
    expect(t.moodle.callsTo('mod_forum_can_add_discussion')).toEqual([{ forumid: FORUM_ID }]);
  });

  it('refuses when the permission check fails or answers without a status', async () => {
    const t = createTestContext();
    forumSite(t);
    const input = { forumType: 'forum' as const, forumId: FORUM_ID, subject: 'Hi', message: 'x' };
    delete t.moodle.handlers.mod_forum_can_add_discussion;
    await expect(prepareForumPost(t.ctx, input)).rejects.toThrow('Could not check whether you may start');
    t.moodle.handlers.mod_forum_can_add_discussion = { warnings: [] };
    await expect(prepareForumPost(t.ctx, input)).rejects.toThrow('Could not check whether you may start');
    expect(t.store.actions.size).toBe(0);
  });

  it('checks the reply capability first and never reads the whole thread', async () => {
    const t = createTestContext();
    const site = forumSite(t);
    site.posts[0] = post(77, { hasparent: false, parentid: null, capabilities: { reply: false } });
    await expect(prepareForumPost(t.ctx, { forumType: 'forum', replyToPostId: 77, message: 'x' })).rejects.toThrow(
      "You can't reply to that post",
    );
    expect(t.moodle.calls.map((c) => c.fn)).toEqual(['mod_forum_get_discussion_post']);
    expect(site.unread.has(79)).toBe(true);
  });

  it('refuses a reply to a post Moodle cannot show', async () => {
    const t = createTestContext();
    await expect(
      prepareForumPost(t.ctx, { forumType: 'forum', replyToPostId: 5, message: 'x' }),
    ).rejects.toBeInstanceOf(NotFound);
  });

  it('refuses hsuforum replies without discussion_id or with canreply false', async () => {
    const t = createTestContext();
    t.moodle.handlers.mod_hsuforum_get_forum_discussion_posts = {
      posts: [{ id: 5, subject: 'News', userfullname: 'Teacher', canreply: false }],
    };
    await expect(prepareForumPost(t.ctx, { forumType: 'hsuforum', replyToPostId: 5, message: 'x' })).rejects.toThrow(
      'discussion_id is required',
    );
    await expect(
      prepareForumPost(t.ctx, { forumType: 'hsuforum', replyToPostId: 5, discussionId: 9, message: 'x' }),
    ).rejects.toThrow("You can't reply to that post");
  });
});

describe('prepareForumPost: dates and provenance', () => {
  it('shows due and cut-off and warns when the due date has passed', async () => {
    const t = createTestContext();
    forumSite(t, { forum: { duedate: NOW_S - 3600, cutoffdate: NOW_S + 86_400 } });
    const p = await prepareForumPost(t.ctx, {
      forumType: 'forum',
      replyToPostId: 77,
      forumCmid: FORUM_CMID,
      message: 'Hello',
    });
    expect(p.details.some((d) => d.startsWith('Due: '))).toBe(true);
    expect(p.details.some((d) => d.startsWith('Posting closes: '))).toBe(true);
    expect(p.warnings.some((w) => w.includes('has passed'))).toBe(true);
    expect(t.moodle.callsTo('mod_forum_get_discussion_posts')).toHaveLength(0);
  });

  it('shows a cut-off without a due date, and refuses once it has passed', async () => {
    const t = createTestContext();
    forumSite(t, { forum: { cutoffdate: NOW_S + 60 } });
    const input = { forumType: 'forum' as const, forumId: FORUM_ID, subject: 'Hi', message: 'x' };
    const p = await prepareForumPost(t.ctx, input);
    expect(p.details.filter((d) => /^(Due|Posting closes):/.test(d))).toHaveLength(1);
    expect(p.details.some((d) => d.startsWith('Posting closes: '))).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    await expect(prepareForumPost(t.ctx, input)).rejects.toThrow('stopped accepting posts');
  });

  it('warns that dates were not checked for a reply without forum_cmid', async () => {
    const t = createTestContext();
    forumSite(t);
    const p = await prepareForumPost(t.ctx, { forumType: 'forum', replyToPostId: 77, message: 'x' });
    expect(p.warnings.some((w) => w.includes('were not checked'))).toBe(true);
  });

  it('refuses a forum_cmid that does not contain the post, or that is an Advanced Forum', async () => {
    const t = createTestContext();
    forumSite(t);
    t.moodle.handlers.mod_forum_get_forum_discussions = { discussions: [] };
    await expect(
      prepareForumPost(t.ctx, { forumType: 'forum', replyToPostId: 77, forumCmid: FORUM_CMID, message: 'x' }),
    ).rejects.toThrow('is not in forum_cmid 7010');
    await expect(
      prepareForumPost(t.ctx, { forumType: 'forum', replyToPostId: 77, forumCmid: HSU_CMID, message: 'x' }),
    ).rejects.toThrow('Advanced Forums (hsuforum) are not supported');
  });
});

describe('prepareForumPost: attachments and subscription', () => {
  it('uploads inline files into a draft and passes it as attachmentsid', async () => {
    const t = createTestContext();
    forumSite(t);
    t.moodle.handlers.mod_forum_add_discussion = { discussionid: 31, warnings: [] };
    const p = await prepareForumPost(t.ctx, {
      forumType: 'forum',
      forumId: FORUM_ID,
      subject: '自己紹介',
      message: 'Hello',
      files: [{ name: 'intro.txt', text: 'hello' }],
      discussionSubscribe: false,
    });
    expect(p.details).toContain('Attachment: intro.txt (5 B)');
    expect(p.details).toContain('Subscribe to this discussion: no');
    expect(t.moodle.uploads.map((u) => [u.name, u.itemId])).toEqual([['intro.txt', 9000]]);

    await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(t.moodle.callsTo('mod_forum_add_discussion')).toEqual([
      {
        forumid: FORUM_ID,
        subject: '自己紹介',
        message: '<p>Hello</p>',
        options: [
          { name: 'discussionsubscribe', value: false },
          { name: 'attachmentsid', value: 9000 },
        ],
      },
    ]);
  });

  it('attaches the files of an upload link to a reply in the named forum', async () => {
    const t = createTestContext();
    const site = forumSite(t);
    t.store.uploads.set('upl_1', {
      id: 'upl_1',
      userId: t.ctx.user.id,
      cmid: FORUM_CMID,
      draftItemId: 4242,
      files: [{ name: 'photo.jpg', size: 2048, mime: 'image/jpeg' }],
      totalBytes: 2048,
      createdAt: NOW.getTime(),
      expiresAt: NOW.getTime() + 60_000,
    });
    t.moodle.handlers.mod_forum_add_discussion_post = { postid: 88, warnings: [] };
    const p = await prepareForumPost(t.ctx, {
      forumType: 'forum',
      replyToPostId: 77,
      forumCmid: FORUM_CMID,
      message: 'See attached',
      uploadId: 'upl_1',
      discussionSubscribe: true,
    });
    expect(p.details).toContain('Attachment: photo.jpg (2.0 KB)');
    expect(t.store.uploads.get('upl_1')?.expiresAt).toBe(0); // consumed
    expect(site.unread.has(79)).toBe(true); // prepare changed no read state

    await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(t.moodle.callsTo('mod_forum_add_discussion_post')).toEqual([
      {
        postid: 77,
        subject: 'Re: 自己紹介',
        message: '<p>See attached</p>',
        messageformat: 1,
        options: [
          { name: 'discussionsubscribe', value: true },
          { name: 'attachmentsid', value: 4242 },
        ],
      },
    ]);
  });

  it('refuses reply attachments without forum_cmid, without permission, or when permission is unknown', async () => {
    const t = createTestContext();
    forumSite(t, { access: { cancreateattachment: false } });
    t.store.uploads.set('upl_3', {
      id: 'upl_3',
      userId: t.ctx.user.id,
      cmid: FORUM_CMID,
      draftItemId: 1,
      files: [{ name: 'a.pdf', size: 1, mime: null }],
      totalBytes: 1,
      createdAt: NOW.getTime(),
      expiresAt: NOW.getTime() + 60_000,
    });
    const base = { forumType: 'forum' as const, replyToPostId: 77, message: 'x', uploadId: 'upl_3' };
    await expect(prepareForumPost(t.ctx, base)).rejects.toThrow('Pass forum_cmid');
    await expect(prepareForumPost(t.ctx, { ...base, forumCmid: FORUM_CMID })).rejects.toThrow(
      'You cannot add attachments',
    );
    delete t.moodle.handlers.mod_forum_get_forum_access_information;
    await expect(prepareForumPost(t.ctx, { ...base, forumCmid: FORUM_CMID })).rejects.toThrow(
      'Could not check whether you may add attachments',
    );
    expect(t.store.uploads.get('upl_3')?.expiresAt).toBeGreaterThan(0); // not consumed
  });

  it('refuses an upload link created for another activity', async () => {
    const t = createTestContext();
    forumSite(t);
    t.store.uploads.set('upl_2', {
      id: 'upl_2',
      userId: t.ctx.user.id,
      cmid: 5001,
      draftItemId: 1,
      files: [{ name: 'a.pdf', size: 1, mime: null }],
      totalBytes: 1,
      createdAt: NOW.getTime(),
      expiresAt: NOW.getTime() + 60_000,
    });
    await expect(
      prepareForumPost(t.ctx, {
        forumType: 'forum',
        replyToPostId: 77,
        forumCmid: FORUM_CMID,
        message: 'x',
        uploadId: 'upl_2',
      }),
    ).rejects.toThrow('belongs to a different forum');
  });

  it("enforces the forum's attachment count, size and availability", async () => {
    const t = createTestContext();
    forumSite(t, { forum: { maxattachments: 1, maxbytes: 4 } });
    const base = { forumType: 'forum' as const, replyToPostId: 77, forumCmid: FORUM_CMID, message: 'x' };
    const two = [
      { name: 'a.txt', text: 'a' },
      { name: 'b.txt', text: 'b' },
    ];
    await expect(prepareForumPost(t.ctx, { ...base, files: two })).rejects.toThrow(
      'Too many attachments: 2 (this forum allows 1).',
    );
    await expect(prepareForumPost(t.ctx, { ...base, files: [{ name: 'big.txt', text: 'hello' }] })).rejects.toThrow(
      'the limit is 4 B',
    );
    for (const forum of [{ maxattachments: 0 }, { maxbytes: 1 }]) {
      t.moodle.handlers.mod_forum_get_forums_by_courses = [forumRaw(forum)];
      await expect(prepareForumPost(t.ctx, { ...base, files: [{ name: 'a.txt', text: 'a' }] })).rejects.toThrow(
        'does not accept attachments',
      );
    }
    expect(t.moodle.uploads).toHaveLength(0);
  });

  it('refuses new-discussion attachments where Moodle says the user cannot attach', async () => {
    const t = createTestContext();
    forumSite(t);
    t.moodle.handlers.mod_forum_can_add_discussion = { status: true, cancreateattachment: false };
    await expect(
      prepareForumPost(t.ctx, {
        forumType: 'forum',
        forumId: FORUM_ID,
        subject: 's',
        message: 'x',
        files: [{ name: 'a.txt', text: 'a' }],
      }),
    ).rejects.toThrow('You cannot add attachments');
  });

  it('refuses attachments and discussion_subscribe on hsuforum', async () => {
    const t = createTestContext();
    t.moodle.handlers.mod_hsuforum_can_add_discussion = { status: true };
    const base = { forumType: 'hsuforum' as const, forumId: 4, subject: 's', message: 'x' };
    await expect(prepareForumPost(t.ctx, { ...base, files: [{ name: 'a.txt', text: 'a' }] })).rejects.toThrow(
      'Advanced Forums (hsuforum) do not support attachments',
    );
    await expect(prepareForumPost(t.ctx, { ...base, discussionSubscribe: true })).rejects.toThrow(
      'discussion_subscribe is not supported',
    );
  });

  it('stores the whole message in the preview and sends no options when nothing was chosen', async () => {
    const t = createTestContext();
    forumSite(t);
    t.moodle.handlers.mod_forum_add_discussion_post = { postid: 90 };
    const long = `${'a'.repeat(4500)} FINAL CHANGE`;
    const p = await prepareForumPost(t.ctx, { forumType: 'forum', replyToPostId: 77, message: long });
    expect(p.details).toContain(`Message: ${long}`);
    await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(t.moodle.callsTo('mod_forum_add_discussion_post')[0]).not.toHaveProperty('options');
  });
});

// ------------------------------------------------------------------ edit

describe('prepareForumPostChange: edit', () => {
  const edit = (over: Record<string, unknown> = {}) => ({
    forumCmid: FORUM_CMID,
    postId: 80,
    action: 'edit' as const,
    ...over,
  });

  it("refuses other people's posts even with edit rights, and posts Moodle will not let the user edit", async () => {
    const t = createTestContext();
    forumSite(t, { posts: ownPosts({ author: { id: OTHER, fullname: 'Hanako Sato' } }) });
    await expect(prepareForumPostChange(t.ctx, edit({ message: 'x' }))).rejects.toThrow('Only your own posts');
    forumSite(t, { posts: ownPosts({ capabilities: { edit: false, delete: false } }) });
    await expect(prepareForumPostChange(t.ctx, edit({ message: 'x' }))).rejects.toThrow("You can't edit this post");
    forumSite(t, { posts: ownPosts() });
    await expect(prepareForumPostChange(t.ctx, edit())).rejects.toThrow('Nothing to change');
  });

  it('needs a standard forum that contains the post', async () => {
    const t = createTestContext();
    forumSite(t, { posts: ownPosts() });
    await expect(prepareForumPostChange(t.ctx, edit({ forumCmid: HSU_CMID, message: 'x' }))).rejects.toThrow(
      'Advanced Forums (hsuforum) are not supported',
    );
    t.moodle.handlers.mod_forum_get_forum_discussions = { discussions: [{ id: 1, discussion: 56 }] };
    await expect(prepareForumPostChange(t.ctx, edit({ message: 'x' }))).rejects.toBeInstanceOf(NotFound);
  });

  it('stores the full current and new text, keeps the subscription and leaves attachments alone', async () => {
    const t = createTestContext();
    const site = forumSite(t, { posts: ownPosts() });
    const long = `${'b'.repeat(4500)} CHANGED AT THE END`;
    const p = await prepareForumPostChange(t.ctx, edit({ subject: 'New', message: long }));
    expect(p.kind).toBe('forum_post_edit');
    expect(p.details).toEqual(
      expect.arrayContaining([
        'Current subject: My answer',
        'New subject: New',
        'Current text: Body of 80',
        `New text: ${long}`,
        'Discussion subscription after saving: on (Moodle sets it on every edit)',
      ]),
    );
    expect(t.moodle.callsTo('mod_forum_get_discussion_posts')).toHaveLength(0);
    const r = await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(r).toMatchObject({
      status: 'executed',
      message: 'Post updated.',
      url: `${BASE_URL}/mod/forum/discuss.php?d=55#p80`,
    });
    const [call] = t.moodle.callsTo('mod_forum_update_discussion_post');
    expect(call).toMatchObject({ postid: 80, subject: 'New', messageformat: 1 });
    expect(call?.options).toEqual([{ name: 'discussionsubscribe', value: true }]);
    expect(site.subscribed).toBe(true);
  });

  it('sends the chosen subscription, and none where the forum fixes it', async () => {
    const t = createTestContext();
    forumSite(t, { posts: ownPosts() });
    const off = await prepareForumPostChange(t.ctx, edit({ message: 'x', discussionSubscribe: false }));
    expect(off.details).toContain('Discussion subscription after saving: off (Moodle sets it on every edit)');
    forumSite(t, { posts: ownPosts(), forum: { forcesubscribe: 1 } });
    await expect(prepareForumPostChange(t.ctx, edit({ message: 'x', discussionSubscribe: true }))).rejects.toThrow(
      'omit discussion_subscribe',
    );
    const forced = await prepareForumPostChange(t.ctx, edit({ message: 'x' }));
    expect(forced.details.some((d) => d.startsWith('Discussion subscription'))).toBe(false);
    await confirmAction(t.ctx, forced.actionId, 'mcp');
    expect(t.moodle.callsTo('mod_forum_update_discussion_post').at(-1)).not.toHaveProperty('options');
  });

  it('keeps the current attachments next to a new one in one draft', async () => {
    const t = createTestContext();
    forumSite(t, { posts: ownPosts() });
    t.moodle.files.set(OLD_FILE_URL, { body: 'pdf' });
    const p = await prepareForumPostChange(t.ctx, edit({ files: [{ name: 'new.txt', text: 'n' }] }));
    expect(p.details).toEqual(
      expect.arrayContaining(['New attachment: new.txt (1 B)', 'Kept attachment: old.pdf (3 B)']),
    );
    expect(t.moodle.uploads.map((u) => [u.name, u.itemId])).toEqual([
      ['new.txt', 9000],
      ['old.pdf', 9000],
    ]);
    await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(t.moodle.callsTo('mod_forum_update_discussion_post')).toEqual([
      {
        postid: 80,
        subject: '',
        message: '',
        messageformat: 1,
        options: [
          { name: 'discussionsubscribe', value: true },
          { name: 'attachmentsid', value: 9000 },
        ],
      },
    ]);
  });

  it('clears all attachments only with the attachment permission', async () => {
    const t = createTestContext();
    forumSite(t, { posts: ownPosts(), access: { cancreateattachment: false } });
    await expect(prepareForumPostChange(t.ctx, edit({ keepExistingFiles: false }))).rejects.toThrow(
      'You cannot add attachments',
    );
    forumSite(t, { posts: ownPosts(), access: { cancreateattachment: false } });
    await expect(prepareForumPostChange(t.ctx, edit({ files: [{ name: 'n.txt', text: 'n' }] }))).rejects.toThrow(
      'You cannot add attachments',
    );
    expect(t.moodle.uploads).toHaveLength(0);

    forumSite(t, { posts: ownPosts() });
    const p = await prepareForumPostChange(t.ctx, edit({ keepExistingFiles: false }));
    expect(p.details).toContain('Removed attachment: old.pdf');
    expect(p.warnings).toContain('Removes all attachments from the post.');
    expect(t.moodle.callsTo('core_files_get_unused_draft_itemid')).toHaveLength(1);
  });

  it('fails when Moodle does not confirm the update', async () => {
    const t = createTestContext();
    forumSite(t, { posts: ownPosts() });
    t.moodle.handlers.mod_forum_update_discussion_post = { status: false, warnings: [] };
    const p = await prepareForumPostChange(t.ctx, edit({ message: 'x' }));
    expect(await confirmAction(t.ctx, p.actionId, 'mcp')).toMatchObject({
      status: 'failed',
      message: 'Moodle did not update the post.',
    });
  });
});

// ------------------------------------------------------------------ delete

describe('prepareForumPostChange: delete', () => {
  const del = (postId: number) => ({ forumCmid: FORUM_CMID, postId, action: 'delete' as const });

  it("refuses other people's posts even with delete rights, and extra fields", async () => {
    const t = createTestContext();
    forumSite(t, { posts: ownPosts({ author: { id: OTHER } }), unread: [] });
    await expect(prepareForumPostChange(t.ctx, del(80))).rejects.toThrow('Only your own posts');
    forumSite(t, { posts: ownPosts(), unread: [] });
    await expect(prepareForumPostChange(t.ctx, { ...del(80), message: 'x' })).rejects.toThrow(
      'Delete takes only forum_cmid and post_id',
    );
  });

  it('deletes an own reply on an automatically marking forum without loading the thread', async () => {
    const t = createTestContext();
    forumSite(t, { posts: ownPosts(), unread: [] });
    const p = await prepareForumPostChange(t.ctx, del(80));
    expect(p).toMatchObject({ kind: 'forum_post_delete', title: 'Delete post "My answer"' });
    expect(p.details).toEqual(['Post: "My answer" by Taro Yamada', 'Text: Body of 80', 'Attachment: old.pdf (3 B)']);
    expect(p.warnings).toEqual(['This cannot be undone.']);
    const r = await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(r).toMatchObject({ message: 'Post deleted.', url: `${BASE_URL}/mod/forum/discuss.php?d=55` });
    expect(t.moodle.callsTo('mod_forum_delete_post')).toEqual([{ postid: 80 }]);
    expect(t.moodle.callsTo('mod_forum_get_discussion_posts')).toHaveLength(0);
  });

  it('leaves a reply arriving after the unread count unread, at prepare and at confirm', async () => {
    // The list reports nothing unread, then a reply under the target arrives before anything else is read.
    const arrive = (t: TestContext, access?: Raw) => {
      const site = forumSite(t, { posts: ownPosts(), unread: [], access });
      const list = t.moodle.handlers.mod_forum_get_forum_discussions as () => Raw;
      t.moodle.handlers.mod_forum_get_forum_discussions = () => {
        const res = list();
        if (!site.posts.some((x) => x.id === 81)) {
          site.posts.push(post(81, { parentid: 80 }));
          site.unread.add(81);
        }
        return res;
      };
      return site;
    };
    const t = createTestContext();
    const mod = arrive(t, { candeleteanypost: true });
    await expect(prepareForumPostChange(t.ctx, del(80))).rejects.toThrow('cannot be listed here');
    expect(mod.unread.has(81)).toBe(true);

    const own = arrive(t);
    const p = await prepareForumPostChange(t.ctx, del(80));
    const r = await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.message).toContain('has replies');
    expect(own.unread.has(81)).toBe(true);
    expect(t.moodle.callsTo('mod_forum_get_discussion_posts')).toHaveLength(0);
  });

  it('fails closed when the replies cannot be read', async () => {
    const t = createTestContext();
    forumSite(t, { posts: ownPosts(), forum: { istracked: false } });
    delete t.moodle.handlers.mod_forum_get_discussion_posts;
    await expect(prepareForumPostChange(t.ctx, del(80))).rejects.toThrow('Could not read the discussion');
  });

  it('refuses a post with replies without mod/forum:deleteanypost, and warns with it', async () => {
    const posts = () => [...ownPosts(), post(81, { parentid: 80 })];
    const untracked = { istracked: false };
    const t = createTestContext();
    forumSite(t, { posts: posts(), forum: untracked });
    await expect(prepareForumPostChange(t.ctx, del(80))).rejects.toThrow('has replies (1)');
    forumSite(t, { posts: [{ ...posts()[0], ...OWN }, ...posts().slice(1)], unread: [] });
    await expect(prepareForumPostChange(t.ctx, del(77))).rejects.toThrow('has replies (2)');
    expect(t.moodle.callsTo('mod_forum_get_discussion_posts')).toHaveLength(1);
    forumSite(t, { posts: posts(), forum: untracked, access: { candeleteanypost: true } });
    const p = await prepareForumPostChange(t.ctx, del(80));
    expect(p.warnings).toEqual(['This cannot be undone.', '1 reply under this post is deleted too.']);
  });

  it('deletes an own discussion without replies without reading the thread', async () => {
    const t = createTestContext();
    forumSite(t, { posts: [post(77, { ...OWN, subject: 'Mine', hasparent: false, parentid: null })], unread: [] });
    const p = await prepareForumPostChange(t.ctx, del(77));
    expect(p.title).toBe('Delete discussion "Mine"');
    expect(p.warnings).toContain('This is the first post: the whole discussion and all its replies are deleted.');
    expect(await confirmAction(t.ctx, p.actionId, 'mcp')).toMatchObject({ message: 'Discussion deleted.', url: null });
    expect(t.moodle.callsTo('mod_forum_get_discussion_posts')).toHaveLength(0);
  });

  it('refuses at confirm when the post or its replies changed after the preview', async () => {
    const t = createTestContext();
    const site = forumSite(t, { posts: ownPosts(), forum: { istracked: false }, access: { candeleteanypost: true } });
    const edited = await prepareForumPostChange(t.ctx, del(80));
    site.posts[1] = { ...site.posts[1], message: '<p>Edited on Moodle</p>', timemodified: NOW_S };
    expect(await confirmAction(t.ctx, edited.actionId, 'mcp')).toMatchObject({ status: 'failed' });

    const replied = await prepareForumPostChange(t.ctx, del(80));
    site.posts.push(post(82, { parentid: 80 }));
    const r = await confirmAction(t.ctx, replied.actionId, 'mcp');
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.message).toContain('changed since the preview');
    expect(t.moodle.callsTo('mod_forum_delete_post')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ mark read

describe('prepareMarkRead: forum discussion', () => {
  it('previews without reading the posts and marks them at confirm', async () => {
    const t = createTestContext();
    const site = forumSite(t);
    t.moodle.handlers.mod_forum_mark_posts_read = true;
    const p = await prepareMarkRead(t.ctx, { forumDiscussionId: 55, forumCmid: FORUM_CMID });
    expect(p).toMatchObject({ kind: 'mark_read', title: "Mark '自己紹介' as read" });
    expect(p.details).toEqual(['Discussion: 自己紹介', 'Unread posts: 1 of 3']);
    expect(t.moodle.callsTo('mod_forum_get_discussion_posts')).toHaveLength(0);
    expect(site.unread.has(79)).toBe(true);
    const r = await confirmAction(t.ctx, p.actionId, 'mcp');
    expect(r).toMatchObject({ status: 'executed', message: 'Discussion marked as read.' });
    expect(t.moodle.callsTo('mod_forum_mark_posts_read')).toEqual([{ postids: [79], discussionid: 55 }]);
  });

  it('refuses manual read marking, untracked forums, missing provenance and Advanced Forums', async () => {
    const t = createTestContext();
    const site = forumSite(t);
    site.posts[0] = { ...site.posts[0], capabilities: { reply: true, controlreadstatus: true } };
    await expect(prepareMarkRead(t.ctx, { forumDiscussionId: 55, forumCmid: FORUM_CMID })).rejects.toThrow(
      'marks forum posts read by hand',
    );
    forumSite(t, { forum: { istracked: false } });
    await expect(prepareMarkRead(t.ctx, { forumDiscussionId: 55, forumCmid: FORUM_CMID })).rejects.toThrow(
      'does not track read posts',
    );
    await expect(prepareMarkRead(t.ctx, { forumDiscussionId: 55 })).rejects.toThrow('needs forum_cmid');
    await expect(prepareMarkRead(t.ctx, { forumDiscussionId: 55, forumCmid: HSU_CMID })).rejects.toThrow(
      'Advanced Forums (hsuforum) are not supported',
    );
  });

  it('refuses a discussion outside the forum and fails when Moodle returns false', async () => {
    const t = createTestContext();
    forumSite(t);
    await expect(prepareMarkRead(t.ctx, { forumDiscussionId: 56, forumCmid: FORUM_CMID })).rejects.toBeInstanceOf(
      NotFound,
    );
    t.moodle.handlers.mod_forum_mark_posts_read = false;
    const p = await prepareMarkRead(t.ctx, { forumDiscussionId: 55, forumCmid: FORUM_CMID });
    expect(await confirmAction(t.ctx, p.actionId, 'mcp')).toMatchObject({ status: 'failed' });
  });

  it('needs exactly one target', async () => {
    const t = createTestContext();
    await expect(prepareMarkRead(t.ctx, { forumDiscussionId: 55, conversationId: 1 })).rejects.toThrow('exactly one');
  });
});

// ------------------------------------------------------------------ upload links

describe('createUploadLink for a forum', () => {
  const forumDetail = (over: Partial<ForumDetail> = {}) =>
    ({
      type: 'forum',
      cmid: FORUM_CMID,
      forumId: FORUM_ID,
      forumType: 'forum',
      courseId: COURSE,
      courseName: '総合日本語３Ｘ',
      name: '自己紹介',
      url: `${BASE_URL}/mod/forum/view.php?id=${FORUM_CMID}`,
      description: '',
      dueAt: null,
      discussions: [],
      ...over,
    }) as ForumDetail;

  it("signs the forum's attachment limits and points at prepare_forum_post", async () => {
    const t = createTestContext();
    forumSite(t);
    vi.mocked(getActivity).mockResolvedValue(forumDetail());
    const link = await createUploadLink(t.ctx, FORUM_CMID);
    expect(link).toMatchObject({ maxBytes: MIB, usedBy: 'prepare_forum_post' });
    expect(await t.signer.verify(link.uploadUrl.split('/u/')[1] ?? '')).toMatchObject({ mb: MIB, mf: 2 });
    expect(t.store.uploads.get(link.uploadId)?.cmid).toBe(FORUM_CMID);
  });

  it('refuses hsuforum, forums without attachments and users who cannot attach', async () => {
    const t = createTestContext();
    forumSite(t, { forum: { maxattachments: 0 } });
    vi.mocked(getActivity).mockResolvedValue(forumDetail());
    await expect(createUploadLink(t.ctx, FORUM_CMID)).rejects.toThrow('does not accept attachments');
    forumSite(t, { access: { cancreateattachment: false } });
    await expect(createUploadLink(t.ctx, FORUM_CMID)).rejects.toThrow('You cannot add attachments');
    vi.mocked(getActivity).mockResolvedValue(forumDetail({ forumType: 'hsuforum' }));
    await expect(createUploadLink(t.ctx, FORUM_CMID)).rejects.toThrow('hsuforum');
    expect(t.moodle.callsTo('core_files_get_unused_draft_itemid')).toHaveLength(0);
  });
});
