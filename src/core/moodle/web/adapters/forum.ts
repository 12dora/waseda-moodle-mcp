/**
 * mod_forum (and read-only mod_hsuforum) on the web channel. Forum ids are REAL here (the ajax functions
 * mod_forum_set_forum_subscription / mod_forum_mark_posts_read need them): they come from the view page, the course
 * overview or the hsuforum index. mod_forum_get_discussion_posts, _add_discussion_post, _mark_posts_read and
 * _set_forum_subscription are ajax-enabled and not emulated.
 *
 * Costs: forums of a course = its overview page (one request, all forums), enriched with what view pages / post forms
 * already read in this session showed; one forum (hint cmid) = its view page; discussions = the view page (the first
 * page usually is that same page); message bodies only on request (hint `messages`), one ajax batch; one post = its
 * edit form and its reply page (the author), or the reply page alone.
 */

import type { CallHint } from '../../../context';
import { MoodleError } from '../../../errors';
import {
  type DraftFile,
  fieldInt,
  type PostForm,
  parsePostForm,
  type RenderedPost,
  renderedPost,
} from '../parse/forum-form';
import { hsuDiscussionPosts, hsuDiscussions, hsuForumsByCourses, hsuInstanceOf } from '../parse/forum-hsu-read';
import { discussionList, idList } from '../parse/forum-list';
import type { OverviewForum } from '../parse/forum-overview';
import {
  cachedForm,
  cachedOverviewRow,
  cachedView,
  hsuView,
  knownCmid,
  newDiscussionForm,
  overviewOf,
  rememberForm,
  viewByCmid,
  viewByForum,
} from '../parse/forum-store';
import type { ForumView } from '../parse/forum-view';
import { addDiscussion, deletePost, updateDiscussionPost } from '../parse/forum-write';
import type { WebFunctions, WebSession } from '../types';

type Params = Record<string, unknown>;

// ------------------------------------------------------------------ forums

interface EntrySource {
  courseId: number;
  cmid: number;
  forumId: number;
  view: ForumView | null;
  row: OverviewForum | null;
  form: PostForm | null;
}

const countOf = (view: ForumView | null) => (view && !view.hasNextPage ? view.rows.length : undefined);

/** One `mod_forum_get_forums_by_courses` entry; fields no page read so far shows stay undefined (unknown). */
function forumEntry({ courseId, cmid, forumId, view, row, form }: EntrySource): Record<string, unknown> {
  const choice = view?.subscriptionChoice ? 0 : undefined;
  return {
    id: forumId,
    course: courseId,
    cmid,
    type: view?.type ?? undefined,
    name: view?.name ?? row?.name ?? '',
    intro: view?.intro ?? '',
    introformat: 1,
    duedate: view ? (view.dueDate ?? 0) : undefined,
    cancreatediscussions: view?.canCreate,
    numdiscussions: row?.numDiscussions ?? countOf(view),
    istracked: row?.tracked ?? undefined,
    forcesubscribe: row?.forceSubscribe ?? choice,
    maxattachments: form ? (form.attachments?.maxFiles ?? 0) : undefined,
    maxbytes: form?.attachments?.maxBytes ?? undefined,
  };
}

/** The page of a cmid that is not a mod_forum activity is a Moodle error: no such forum in the course. */
async function viewOrNull(web: WebSession, cmid: number): Promise<ForumView | null> {
  try {
    return await viewByCmid(web, cmid);
  } catch (e) {
    if (e instanceof MoodleError) return null;
    throw e;
  }
}

async function hintedForum(web: WebSession, cmid: number, courseIds: number[]): Promise<unknown[]> {
  const view = await viewOrNull(web, cmid);
  if (!view) return [];
  const courseId = view.courseId;
  if (courseId === null || (courseIds.length > 0 && !courseIds.includes(courseId))) return [];
  let row = await cachedOverviewRow(web, courseId, cmid);
  if (view.forumId === null && !row) row = (await overviewOf(web, courseId)).find((r) => r.cmid === cmid) ?? null;
  const forumId = view.forumId ?? row?.forumId;
  if (!forumId) return [];
  return [forumEntry({ courseId, cmid, forumId, view, row, form: cachedForm(web, forumId) })];
}

async function forumsByCourses(web: WebSession, params: Params, hint: CallHint): Promise<unknown> {
  const courseIds = idList(params.courseids);
  if (hint.cmid) return hintedForum(web, hint.cmid, courseIds);
  const lists = await Promise.all(
    courseIds.map(async (courseId) =>
      (await overviewOf(web, courseId)).map((row) =>
        forumEntry({
          courseId,
          cmid: row.cmid,
          forumId: row.forumId,
          row,
          view: cachedView(web, row.cmid),
          form: cachedForm(web, row.forumId),
        }),
      ),
    ),
  );
  return lists.flat();
}

// ------------------------------------------------------------------ one post

const draftAttachment = (f: DraftFile) => ({
  filename: f.filename,
  filepath: '/',
  filesize: f.filesize,
  fileurl: f.url,
  mimetype: f.mimetype,
});

/**
 * The edit form opens for the user's own posts within the editing time, but also for anyone's post with
 * mod/forum:editanypost, and it does not name the author: the author comes from the post as Moodle renders it above
 * the reply form (`shown`); unknown when that page is not available (callers then refuse to treat it as own).
 */
function postFromEditForm(postId: number, form: PostForm, shown: RenderedPost | null): Record<string, unknown> {
  const parent = fieldInt(form, 'parent');
  return {
    id: postId,
    discussionid: fieldInt(form, 'discussion'),
    hasparent: parent !== null,
    parentid: parent,
    subject: form.fields.get('subject') ?? '',
    message: form.fields.get('message[text]') ?? '',
    author: { id: shown?.authorId ?? undefined, fullname: shown?.author ?? undefined },
    timecreated: shown?.created ?? undefined,
    // Editable means within the editing time, when Moodle also allows deleting and the user can post here.
    capabilities: { reply: true, edit: true, delete: true, controlreadstatus: false },
    attachments: (form.attachments?.files ?? []).map(draftAttachment),
  };
}

function postFromReplyPage(postId: number, form: PostForm, shown: RenderedPost | null): Record<string, unknown> {
  return {
    id: postId,
    discussionid: fieldInt(form, 'discussion'),
    subject: shown?.subject ?? '',
    message: shown?.message ?? '',
    author: { id: shown?.authorId ?? undefined, fullname: shown?.author ?? undefined },
    timecreated: shown?.created ?? undefined,
    capabilities: { reply: true, edit: false, delete: false, controlreadstatus: false },
    attachments: [],
  };
}

/** Edit and reply forms show the forum's attachment manager: keep it for the forum's settings. */
function remembered(web: WebSession, form: PostForm): PostForm {
  const forumId = fieldInt(form, 'forum');
  if (forumId !== null) rememberForm(web, forumId, form);
  return form;
}

/** A post.php page, or null when Moodle refuses it (error page). */
async function postPage(web: WebSession, query: string): Promise<string | null> {
  try {
    return (await web.page(`/mod/forum/post.php?${query}`)).html;
  } catch (e) {
    if (e instanceof MoodleError) return null;
    throw e;
  }
}

/**
 * `mod_forum_get_discussion_post` without marking anything read: the edit form (editable posts; its attachment
 * manager is remembered for the forum) plus the reply page, which renders the post with its author; else the reply
 * form alone. A post the user can neither edit nor reply to is not readable this way.
 */
async function discussionPost(web: WebSession, params: Params): Promise<unknown> {
  const postId = idList([params.postid])[0];
  if (!postId) throw new MoodleError('Invalid post id.', 'invalidparameter');
  const editHtml = await postPage(web, `edit=${postId}`);
  const edit = editHtml === null ? null : parsePostForm(editHtml);
  if (edit) remembered(web, edit);
  const replyHtml = await postPage(web, `reply=${postId}`);
  const shown = replyHtml === null ? null : renderedPost(replyHtml, postId);
  if (edit) return { post: postFromEditForm(postId, edit, shown), warnings: [] };
  const reply = replyHtml === null ? null : parsePostForm(replyHtml);
  if (!reply) throw new MoodleError('The post was not found or is not visible.', 'invalidrecord');
  return { post: postFromReplyPage(postId, remembered(web, reply), shown), warnings: [] };
}

// ------------------------------------------------------------------ rights

async function canAddDiscussion(web: WebSession, params: Params): Promise<unknown> {
  const forumId = idList([params.forumid])[0];
  const form = forumId ? await newDiscussionForm(web, forumId) : null;
  return {
    status: form !== null,
    canpindiscussions: form?.fields.has('pinned') ?? false,
    cancreateattachment: form ? form.attachments !== null : false,
    warnings: [],
  };
}

/**
 * Only the attachment right is visible to a student: a post form of the forum shows the attachment manager when the
 * user has mod/forum:createattachment (any form seen in this session, else the new-discussion form). The rest of
 * the WS answer (candeleteanypost, …) is unknown and left out.
 */
async function accessInformation(web: WebSession, params: Params): Promise<unknown> {
  const forumId = idList([params.forumid])[0];
  if (!forumId) return { warnings: [] };
  const form = cachedForm(web, forumId) ?? (await newDiscussionForm(web, forumId));
  return form ? { cancreateattachment: form.attachments !== null, warnings: [] } : { warnings: [] };
}

// ------------------------------------------------------------------ instance ids (A1's course-module adapters)

/** The real forum id of the forum activity `cmid` (`module` hsuforum: Advanced Forum); null when no page shows it. */
export async function forumInstanceOf(
  web: WebSession,
  cmid: number,
  courseId: number,
  module: 'forum' | 'hsuforum' = 'forum',
): Promise<number | null> {
  if (module === 'hsuforum') return hsuInstanceOf(web, cmid, courseId);
  const view = await viewByCmid(web, cmid);
  if (view.forumId !== null) return view.forumId;
  return (await overviewOf(web, view.courseId ?? courseId)).find((r) => r.cmid === cmid)?.forumId ?? null;
}

/** The cmid of forum `instance` (its view page by forum id; free when a page of this session showed it). */
export async function forumCmidOf(
  web: WebSession,
  instance: number,
  module: 'forum' | 'hsuforum' = 'forum',
): Promise<number | null> {
  if (module === 'hsuforum') return (await hsuView(web, { forumId: instance })).cmid;
  return knownCmid(web, instance) ?? (await viewByForum(web, instance)).cmid;
}

export const forumFunctions: WebFunctions = {
  mod_forum_get_forums_by_courses: forumsByCourses,
  mod_forum_get_forum_discussions: (web, params, hint) => discussionList(web, params, hint),
  mod_forum_get_discussion_post: (web, params) => discussionPost(web, params),
  mod_forum_can_add_discussion: (web, params) => canAddDiscussion(web, params),
  mod_forum_get_forum_access_information: (web, params) => accessInformation(web, params),
  mod_forum_add_discussion: (web, params) => addDiscussion(web, params),
  mod_forum_update_discussion_post: (web, params) => updateDiscussionPost(web, params),
  mod_forum_delete_post: (web, params) => deletePost(web, params),
  mod_hsuforum_get_forums_by_courses: hsuForumsByCourses,
  mod_hsuforum_get_forum_discussions: (web, params) => hsuDiscussions(web, params),
  mod_hsuforum_get_forum_discussions_paginated: (web, params) => hsuDiscussions(web, params),
  mod_hsuforum_get_forum_discussion_posts: (web, params) => hsuDiscussionPosts(web, params),
};
