/**
 * Read-only mod_hsuforum functions on the web channel (Advanced Forum writes are refused by the services there):
 *   mod_hsuforum_get_forums_by_courses             — index.php per course (cmids: by name, course structures)
 *   mod_hsuforum_get_forum_discussions(_paginated) — view.php?f=<id>
 *   mod_hsuforum_get_forum_discussion_posts        — discuss.php?d=<id>
 */

import type { CallHint } from '../../../context';
import { MoodleError } from '../../../errors';
import { decodeEntities } from '../../../html';
import type { WebSession } from '../types';
import { parseHsuDiscussions, parseHsuPosts } from './forum-hsu';
import { idList } from './forum-list';
import { type HsuView, hsuIndexOf, hsuView } from './forum-store';

type Params = Record<string, unknown>;

interface StateCm {
  id: number;
  name: string;
}

/** hsuforum activities of a course in course order (ajax core_courseformat_get_state; `data` is a JSON string). */
async function hsuCms(web: WebSession, courseId: number): Promise<StateCm[]> {
  const data = await web.ajax<unknown>('core_courseformat_get_state', { courseid: courseId });
  let state: { cm?: { id?: unknown; name?: unknown; module?: unknown }[] } | null = null;
  try {
    state = typeof data === 'string' ? JSON.parse(data) : (data as typeof state);
  } catch {
    return [];
  }
  return (state?.cm ?? [])
    .filter((cm) => cm.module === 'hsuforum')
    .map((cm) => ({ id: Number(cm.id), name: decodeEntities(String(cm.name ?? '')) }))
    .filter((cm) => Number.isSafeInteger(cm.id) && cm.id > 0);
}

/** Index rows have no cmid: the activity of the same name, each used once, in course order. */
function cmidsByName(names: string[], cms: StateCm[]): (number | null)[] {
  const used = new Set<number>();
  return names.map((name) => {
    const cm = cms.find((c) => !used.has(c.id) && c.name.trim() === name.trim());
    if (!cm) return null;
    used.add(cm.id);
    return cm.id;
  });
}

/**
 * The course's forums from its index; `cms` gives its hsuforum activities (the course structure; several courses
 * start theirs in one tick so they share one ajax request).
 */
async function courseForums(
  web: WebSession,
  courseId: number,
  cms: () => Promise<StateCm[]>,
): Promise<Record<string, unknown>[]> {
  const rows = await hsuIndexOf(web, courseId);
  if (rows.length === 0) return [];
  const cmids = cmidsByName(
    rows.map((r) => r.name),
    await cms(),
  );
  return rows.map((r, i) => ({
    id: r.forumId,
    course: courseId,
    cmid: cmids[i] ?? null,
    name: r.name,
    intro: r.intro,
    introformat: 1,
    numdiscussions: r.numDiscussions ?? undefined,
  }));
}

/** The forum id of an hsuforum activity: from its view page, else the index row of the same name. */
export async function hsuInstanceOf(web: WebSession, cmid: number, courseId: number): Promise<number | null> {
  const view = await hsuView(web, { cmid });
  if (view.forumId !== null) return view.forumId;
  return byName(await hsuIndexOf(web, view.courseId ?? courseId), view);
}

function byName(rows: { forumId: number; name: string }[], view: HsuView): number | null {
  if (!view.name) return null;
  const same = rows.filter((r) => r.name.trim() === view.name?.trim());
  return same.length === 1 ? (same[0]?.forumId ?? null) : null;
}

export async function hsuForumsByCourses(web: WebSession, params: Params, hint: CallHint): Promise<unknown> {
  const courseIds = idList(params.courseids);
  if (hint.cmid) {
    const courseId = (await hsuView(web, { cmid: hint.cmid }).catch(notHsu))?.courseId ?? null;
    if (courseId === null || (courseIds.length > 0 && !courseIds.includes(courseId))) return [];
    const forumId = await hsuInstanceOf(web, hint.cmid, courseId);
    const all = await courseForums(web, courseId, () => hsuCms(web, courseId));
    return all.filter((f) => f.id === forumId).map((f) => ({ ...f, cmid: hint.cmid }));
  }
  const courses = courseIds.map((courseId) => ({ courseId, cms: softCms(hsuCms(web, courseId)) }));
  return (await Promise.all(courses.map((c) => courseForums(web, c.courseId, () => c.cms)))).flat();
}

/** A course whose structure Moodle refuses lists its forums without cmids (as when no name matches). */
function softCms(p: Promise<StateCm[]>): Promise<StateCm[]> {
  const out = p.catch((e: unknown) => {
    if (e instanceof MoodleError) return [];
    throw e;
  });
  out.catch(() => {}); // awaited only for courses whose index lists forums
  return out;
}

/** A cmid of another module type has no hsuforum page (Moodle error page). */
function notHsu(e: unknown): null {
  if (e instanceof MoodleError) return null;
  throw e;
}

const pageParam = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0);

export async function hsuDiscussions(web: WebSession, params: Params): Promise<unknown> {
  const forumId = idList([params.forumid])[0];
  if (!forumId) throw new MoodleError('Invalid forum id.', 'invalidparameter');
  const page = pageParam(params.page);
  const html = (await web.page(`/mod/hsuforum/view.php?f=${forumId}${page > 0 ? `&page=${page}` : ''}`)).html;
  const perpage = pageParam(params.perpage);
  const list = parseHsuDiscussions(html);
  return {
    discussions: (perpage > 0 ? list.slice(0, perpage) : list).map((d) => ({
      id: d.firstPostId,
      discussion: d.discussion,
      name: d.subject,
      subject: d.subject,
      userfullname: d.author ?? '',
      created: d.created ?? undefined,
      modified: d.created ?? undefined,
    })),
    warnings: [],
  };
}

export async function hsuDiscussionPosts(web: WebSession, params: Params): Promise<unknown> {
  const discussionId = idList([params.discussionid])[0];
  if (!discussionId) throw new MoodleError('Invalid discussion id.', 'invalidparameter');
  const html = (await web.page(`/mod/hsuforum/discuss.php?d=${discussionId}`)).html;
  return {
    posts: parseHsuPosts(html).map((p) => ({
      id: p.id,
      discussion: discussionId,
      parent: p.parent,
      created: p.created ?? undefined,
      modified: p.created ?? undefined,
      subject: p.subject,
      message: p.message,
      userfullname: p.author ?? '',
      attachments: [],
      canreply: p.canReply,
    })),
    warnings: [],
  };
}
