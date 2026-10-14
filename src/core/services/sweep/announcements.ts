/** Deadlines mentioned in recent announcements (news forums of the scope courses). */

import type { MoodleApi } from '../../context';
import { BudgetExceeded, MoodleError, MoodleUnavailable } from '../../errors';
import { decodeEntities, htmlToMarkdown } from '../../html';
import type { Course, DueItem } from '../../types';
import { buildSweepItem } from './due-item';
import { findDeadlines } from './extract-text';
import { CallBudget } from './types';

const FORUMS_FN = 'mod_forum_get_forums_by_courses';
const DISCUSSIONS_FN = 'mod_forum_get_forum_discussions';
const CREATED_DESC = 3;
const RECENT_MS = 14 * 86_400_000;
const MAX_FORUMS = 4;
const HOUR_MS = 3_600_000;
/** Moodle calls announcementItems may use: the forum list plus MAX_FORUMS discussion lists. */
export const ANNOUNCE_CALLS = 1 + MAX_FORUMS;
const PER_FORUM = 10;
const PER_DISCUSSION = 3;
const MESSAGE_MAX = 4000;

interface RawForum {
  id?: number;
  course?: number;
  cmid?: number;
  type?: string;
}

interface RawDiscussion {
  discussion?: number;
  name?: string;
  subject?: string;
  message?: string;
  created?: number;
  timemodified?: number;
}

const soft = (e: unknown) => e instanceof MoodleError || e instanceof MoodleUnavailable || e instanceof BudgetExceeded;

async function softly<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (soft(e)) return fallback;
    throw e;
  }
}

function discussionItems(
  api: MoodleApi,
  forum: { forum: RawForum; course: Course },
  opts: { now: number; list: readonly RawDiscussion[] },
): DueItem[] {
  const out: DueItem[] = [];
  for (const d of opts.list) {
    const at = (d.created || d.timemodified || 0) * 1000;
    if (!d.discussion || opts.now - at > RECENT_MS) continue;
    const subject = decodeEntities(d.subject || d.name || '');
    const url = `${api.baseUrl}/mod/forum/discuss.php?d=${d.discussion}`;
    const text = `${subject}\n${htmlToMarkdown(d.message, { maxChars: MESSAGE_MAX })}`;
    for (const hit of findDeadlines(text, opts.now, { max: PER_DISCUSSION })) {
      out.push(
        buildSweepItem({
          now: opts.now,
          course: forum.course,
          kind: 'other',
          cmid: forum.forum.cmid ?? null,
          name: subject,
          url,
          dueMs: hit.ms,
          text: { evidence: hit.evidence, sourceUrl: url },
          firstSeen: at,
        }),
      );
    }
  }
  return out;
}

/** The same list starting at a different place every hour, so no forum is skipped every time. */
function rotated<T>(list: readonly T[], now: number): T[] {
  const start = list.length === 0 ? 0 : Math.floor(now / HOUR_MS) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

/**
 * One forums call for all courses + one discussions call per news forum (max 4; with more news forums
 * the starting forum rotates hourly), all within `maxCalls`. Per-forum failures (no permission, network) are skipped.
 */
export async function announcementItems(
  api: MoodleApi,
  courses: readonly Course[],
  opts: { now: number; maxCalls: number },
): Promise<DueItem[]> {
  const budget = new CallBudget(opts.maxCalls);
  if (courses.length === 0 || !budget.take()) return [];
  const byId = new Map(courses.map((c) => [c.id, c]));
  const forums = await softly(
    api.call<RawForum[]>(FORUMS_FN, { courseids: courses.map((c) => c.id) }),
    [] as RawForum[],
  );
  const candidates: Array<{ forum: RawForum; course: Course }> = [];
  for (const forum of Array.isArray(forums) ? forums : []) {
    const course = byId.get(Number(forum.course));
    if (forum.type === 'news' && forum.id && course) candidates.push({ forum, course });
  }
  candidates.sort((a, b) => (a.forum.id ?? 0) - (b.forum.id ?? 0));
  const news = rotated(candidates, opts.now)
    .slice(0, MAX_FORUMS)
    .filter(() => budget.take());
  const lists = await Promise.all(
    news.map((n) =>
      softly(
        api.call<{ discussions?: RawDiscussion[] }>(DISCUSSIONS_FN, {
          forumid: n.forum.id,
          sortorder: CREATED_DESC,
          page: 0,
          perpage: PER_FORUM,
        }),
        {},
      ),
    ),
  );
  return news.flatMap((n, i) => discussionItems(api, n, { now: opts.now, list: lists[i]?.discussions ?? [] }));
}
