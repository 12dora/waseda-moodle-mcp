/**
 * `mod_forum_get_forum_discussions` {forumid, sortorder, page, perpage} from the forum view page's discussion list.
 * The list has no message bodies and no first-post id (except for discussions without replies, whose latest post is
 * the first); a caller that reads `message` passes the hint `messages` and gets each discussion's first post from
 * the ajax mod_forum_get_discussion_posts (one batch). That call marks the posts read on tracked forums with
 * automatic marking, so it is opt-in.
 */

import type { CallHint } from '../../../context';
import { MoodleError } from '../../../errors';
import type { WebSession } from '../types';
import { viewByForum, viewPage } from './forum-store';
import type { DiscussionRow } from './forum-view';

type Params = Record<string, unknown>;

/** Hint for discussion lists: also return each discussion's first post (`message`, exact `created`). */
type DiscussionsHint = CallHint;

/** Moodle pages read for one call at most (the first is usually already fetched). */
const MAX_PAGES = 5;

export const idList = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0) : [];

const intParam = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : fallback);

type Key = (r: DiscussionRow) => number | null;
const SORTS: Record<number, { key: Key; desc: boolean }> = {
  1: { key: (r) => r.modified ?? r.created, desc: true },
  2: { key: (r) => r.modified ?? r.created, desc: false },
  3: { key: (r) => r.created, desc: true },
  4: { key: (r) => r.created, desc: false },
  5: { key: (r) => r.replies, desc: true },
  6: { key: (r) => r.replies, desc: false },
};

/** Moodle's discussion vault order: pinned first, then the sort key (unknown values last); stable otherwise. */
function sorted(rows: DiscussionRow[], sortorder: number): DiscussionRow[] {
  const sort = SORTS[sortorder];
  if (!sort) return rows;
  const value = (r: DiscussionRow) => sort.key(r) ?? (sort.desc ? -Infinity : Infinity);
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return sort.desc ? value(b) - value(a) : value(a) - value(b);
  });
}

/** Rows of Moodle pages 0, 1, … until `wanted` rows are there or the list ends. */
async function collectRows(web: WebSession, forumId: number, wanted: number): Promise<DiscussionRow[]> {
  const first = await viewByForum(web, forumId);
  const rows = [...first.rows];
  let more = first.hasNextPage;
  for (let p = 1; more && rows.length < wanted && p < MAX_PAGES; p++) {
    const next = await viewPage(web, forumId, p);
    rows.push(...next.rows);
    more = next.hasNextPage && next.rows.length > 0;
  }
  return rows;
}

interface FirstPost {
  id: number;
  message: string;
  created: number | null;
}

function firstPostOf(answer: unknown): FirstPost | null {
  const posts = (answer as { posts?: unknown[] } | null)?.posts;
  if (!Array.isArray(posts)) return null;
  const first = posts.find((p) => (p as { hasparent?: unknown }).hasparent === false) ?? posts[0];
  const p = first as { id?: unknown; message?: unknown; timecreated?: unknown } | undefined;
  if (!p || typeof p.id !== 'number') return null;
  return {
    id: p.id,
    message: typeof p.message === 'string' ? p.message : '',
    created: typeof p.timecreated === 'number' ? p.timecreated : null,
  };
}

/** First posts of the discussions, in one ajax tick; a discussion Moodle refuses keeps no body. */
function firstPosts(web: WebSession, rows: DiscussionRow[]): Promise<(FirstPost | null)[]> {
  return Promise.all(
    rows.map((r) =>
      web
        .ajax('mod_forum_get_discussion_posts', { discussionid: r.discussion, sortby: 'created', sortdirection: 'ASC' })
        .then(firstPostOf, (e: unknown) => {
          if (e instanceof MoodleError) return null;
          throw e;
        }),
    ),
  );
}

function wsDiscussion(r: DiscussionRow, first: FirstPost | null): Record<string, unknown> {
  const firstPostId = first?.id ?? (r.replies === 0 ? r.latestPostId : null);
  const created = first?.created ?? r.created;
  return {
    id: firstPostId,
    discussion: r.discussion,
    name: r.subject,
    subject: r.subject,
    message: first?.message ?? null,
    userid: r.authorId ?? undefined,
    userfullname: r.author ?? '',
    created: created ?? undefined,
    modified: r.modified ?? created ?? undefined,
    timemodified: r.modified ?? created ?? undefined,
    numreplies: r.replies ?? 0,
    numunread: r.unread ?? 0,
    pinned: r.pinned,
  };
}

export async function discussionList(web: WebSession, params: Params, hint: DiscussionsHint): Promise<unknown> {
  const forumId = idList([params.forumid])[0];
  if (!forumId) throw new MoodleError('Invalid forum id.', 'invalidparameter');
  const page = Math.max(0, intParam(params.page, 0));
  const perpage = intParam(params.perpage, 0);
  const offset = perpage > 0 ? page * perpage : 0;
  const wanted = perpage > 0 ? offset + perpage : Number.POSITIVE_INFINITY;
  const rows = sorted(await collectRows(web, forumId, wanted), intParam(params.sortorder, -1));
  const slice = perpage > 0 ? rows.slice(offset, offset + perpage) : rows;
  const bodies = hint.messages ? await firstPosts(web, slice) : slice.map(() => null);
  return { discussions: slice.map((r, i) => wsDiscussion(r, bodies[i] ?? null)), warnings: [] };
}
