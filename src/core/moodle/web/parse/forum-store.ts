/**
 * Forum pages read through one WebSession, parsed once and remembered for the session object's lifetime (one
 * invocation). Every read also records forum id ↔ cmid, so a later call by forum id reuses the page already fetched by
 * cmid (`/mod/forum/view.php?id=` and `?f=` are different paths for the page memo). Which page answers what:
 *   view page      — type, name, intro, due date, add-discussion right, first discussion page
 *   course overview — forum ids of all forums of a course, discussion counts, tracking and subscription state
 *   post form      — attachment limits and right (mod/forum:createattachment)
 */

import { MoodleError } from '../../../errors';
import { attr, findFirst, pageConfig } from '../html';
import type { WebSession } from '../types';
import { type PostForm, parsePostForm } from './forum-form';
import { type HsuIndexForum, hsuForumIdOf, parseHsuIndex } from './forum-hsu';
import { type OverviewForum, parseForumOverview } from './forum-overview';
import { type ForumView, parseForumView } from './forum-view';

interface ForumStore {
  views: Map<number, ForumView>;
  cmidOf: Map<number, number>;
  overviews: Map<number, Promise<OverviewForum[]>>;
  /** Any post form seen per forum id (new discussion, edit, reply): attachment manager and right. */
  forms: Map<number, PostForm>;
  /** The new-discussion form per forum id; null = Moodle refused it. */
  newForms: Map<number, PostForm | null>;
}

const stores = new WeakMap<WebSession, ForumStore>();

function storeOf(web: WebSession): ForumStore {
  let s = stores.get(web);
  if (!s) {
    s = { views: new Map(), cmidOf: new Map(), overviews: new Map(), forms: new Map(), newForms: new Map() };
    stores.set(web, s);
  }
  return s;
}

/** Drops what this session read about forums (after a write: lists, counts and forms changed). */
export function forgetForums(web: WebSession): void {
  stores.delete(web);
}

function remember(web: WebSession, view: ForumView): ForumView {
  const s = storeOf(web);
  if (view.cmid !== null) s.views.set(view.cmid, view);
  if (view.cmid !== null && view.forumId !== null) s.cmidOf.set(view.forumId, view.cmid);
  return view;
}

/** The view page of the forum activity `cmid` (first discussion page). */
export async function viewByCmid(web: WebSession, cmid: number): Promise<ForumView> {
  const cached = storeOf(web).views.get(cmid);
  if (cached) return cached;
  const page = await web.page(`/mod/forum/view.php?id=${cmid}`);
  return remember(web, { ...parseForumView(page.html), cmid: pageConfig(page.html).contextInstanceId ?? cmid });
}

/** The view page of forum `forumId`; through its cmid when known (same page, already fetched). */
export async function viewByForum(web: WebSession, forumId: number): Promise<ForumView> {
  const cmid = storeOf(web).cmidOf.get(forumId);
  if (cmid !== undefined) return viewByCmid(web, cmid);
  const page = await web.page(`/mod/forum/view.php?f=${forumId}`);
  const view = parseForumView(page.html);
  return remember(web, { ...view, forumId: view.forumId ?? forumId });
}

/** A later page of a forum's discussion list (`p` = Moodle page number, Moodle's page size). Not cached. */
export async function viewPage(web: WebSession, forumId: number, pageNo: number): Promise<ForumView> {
  if (pageNo === 0) return viewByForum(web, forumId);
  const page = await web.page(`/mod/forum/view.php?f=${forumId}&p=${pageNo}`);
  return parseForumView(page.html, pageNo);
}

/** Forum rows of the course's activity overview (one page per course). */
export function overviewOf(web: WebSession, courseId: number): Promise<OverviewForum[]> {
  const s = storeOf(web);
  let rows = s.overviews.get(courseId);
  if (!rows) {
    rows = web.page(`/course/overview.php?id=${courseId}&expand[]=forum`).then((p) => {
      const list = parseForumOverview(p.html);
      for (const r of list) s.cmidOf.set(r.forumId, r.cmid);
      return list;
    });
    s.overviews.set(courseId, rows);
    rows.catch(() => s.overviews.delete(courseId));
  }
  return rows;
}

/** The overview row of a cached forum, without fetching anything. */
export async function cachedOverviewRow(
  web: WebSession,
  courseId: number,
  cmid: number,
): Promise<OverviewForum | null> {
  const rows = storeOf(web).overviews.get(courseId);
  if (!rows) return null;
  try {
    return (await rows).find((r) => r.cmid === cmid) ?? null;
  } catch {
    return null;
  }
}

export const cachedView = (web: WebSession, cmid: number): ForumView | null => storeOf(web).views.get(cmid) ?? null;
export const cachedForm = (web: WebSession, forumId: number): PostForm | null =>
  storeOf(web).forms.get(forumId) ?? null;

/** A post form seen for forum `forumId` (edit / reply forms carry the same attachment manager). */
export function rememberForm(web: WebSession, forumId: number, form: PostForm): void {
  const s = storeOf(web);
  if (!s.forms.has(forumId)) s.forms.set(forumId, form);
}

/**
 * The new-discussion form `post.php?forum=<id>`; null when Moodle refuses it (no right to start a discussion here).
 * Opening the form changes nothing (Moodle only reserves draft area ids).
 */
export async function newDiscussionForm(web: WebSession, forumId: number): Promise<PostForm | null> {
  const s = storeOf(web);
  const known = s.newForms.get(forumId);
  if (known !== undefined) return known;
  let form: PostForm | null;
  try {
    form = parsePostForm((await web.page(`/mod/forum/post.php?forum=${forumId}`)).html);
  } catch (e) {
    if (!(e instanceof MoodleError)) throw e;
    form = null;
  }
  s.newForms.set(forumId, form);
  if (form) rememberForm(web, forumId, form);
  return form;
}

// ------------------------------------------------------------------ hsuforum

const hsuIndexes = new WeakMap<WebSession, Map<number, Promise<HsuIndexForum[]>>>();

export function hsuIndexOf(web: WebSession, courseId: number): Promise<HsuIndexForum[]> {
  let byCourse = hsuIndexes.get(web);
  if (!byCourse) {
    byCourse = new Map();
    hsuIndexes.set(web, byCourse);
  }
  let rows = byCourse.get(courseId);
  if (!rows) {
    rows = web.page(`/mod/hsuforum/index.php?id=${courseId}`).then((p) => parseHsuIndex(p.html));
    byCourse.set(courseId, rows);
    const map = byCourse;
    rows.catch(() => map.delete(courseId));
  }
  return rows;
}

export interface HsuView {
  cmid: number | null;
  courseId: number | null;
  forumId: number | null;
  name: string | null;
}

/** The hsuforum view page (`?id=<cmid>` or `?f=<forum id>`). */
export async function hsuView(web: WebSession, by: { cmid?: number; forumId?: number }): Promise<HsuView> {
  const query = by.cmid !== undefined ? `id=${by.cmid}` : `f=${by.forumId}`;
  const page = await web.page(`/mod/hsuforum/view.php?${query}`);
  const cfg = pageConfig(page.html);
  const info = findFirst(page.html, { attr: 'data-region', value: 'activity-information' });
  return {
    cmid: cfg.contextInstanceId,
    courseId: cfg.courseId,
    forumId: hsuForumIdOf(page.html) ?? by.forumId ?? null,
    name: (info && attr(info.attrs, 'data-activityname')) || null,
  };
}

/** The cmid of mod_forum forum `forumId` when a page of this session already showed it (no request). */
export function knownCmid(web: WebSession, forumId: number): number | null {
  return storeOf(web).cmidOf.get(forumId) ?? null;
}
