/** Deadlines mentioned in recent announcements (news forums of the scope courses). */

import type { CallHint, MoodleApi } from '../../context';
import { BudgetExceeded, MoodleError, MoodleUnavailable } from '../../errors';
import { decodeEntities, htmlToMarkdown } from '../../html';
import type { Course, DueItem } from '../../types';
import { buildSweepItem } from './due-item';
import { findDeadlines } from './extract-text';
import { CallBudget } from './types';

const DAY_MS = 86_400_000;
const FORUMS_FN = 'mod_forum_get_forums_by_courses';
const DISCUSSIONS_FN = 'mod_forum_get_forum_discussions';
const CREATED_DESC = 3;
const RECENT_MS = 14 * DAY_MS;
const MAX_FORUMS = 4;
/** Moodle calls announcementItems may use: the forum list plus MAX_FORUMS discussion lists. */
export const ANNOUNCE_CALLS = 1 + MAX_FORUMS;
const PER_FORUM = 10;
const PER_DISCUSSION = 3;
const MESSAGE_MAX = 4000;
/** Web channel: list discussions with their first posts (the page list has no bodies; one ajax batch per forum). */
const WITH_MESSAGES: CallHint = { messages: true };
/** Web channel: one forum = its view page (the discussions reuse it) + the first-post batch. */
const WEB_CALLS_PER_FORUM = 2;

interface RawForum {
  id?: number;
  course?: number;
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
    for (const hit of findDeadlines(text, opts.now, { max: PER_DISCUSSION, from: opts.now - DAY_MS })) {
      out.push(
        buildSweepItem({
          now: opts.now,
          course: forum.course,
          kind: 'other',
          cmid: null, // the news forum is only where the date was mentioned, not the task itself
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

/** The same list from a random starting point, so a user checking at fixed times does not always miss the same forums. */
function rotated<T>(list: readonly T[]): T[] {
  const start = Math.floor(Math.random() * list.length);
  return [...list.slice(start), ...list.slice(0, start)];
}

/**
 * One forums call for all courses + one discussions call per news forum (max 4; with more news forums
 * the starting forum is random on every run), all within `maxCalls`. Per-forum failures (no permission, network) are
 * skipped. On the web channel the course structures replace the forums call (see webNewsForums).
 */
export async function announcementItems(
  api: MoodleApi,
  courses: readonly Course[],
  opts: { now: number; maxCalls: number },
): Promise<DueItem[]> {
  const budget = new CallBudget(opts.maxCalls);
  if (courses.length === 0 || !budget.take()) return [];
  const web = api.channel === 'web';
  const news = web ? await webNewsForums(api, courses, budget) : await newsForums(api, courses, budget);
  const hint = web ? WITH_MESSAGES : undefined;
  const lists = await Promise.all(
    news.map((n) =>
      softly(
        api.call<{ discussions?: RawDiscussion[] }>(
          DISCUSSIONS_FN,
          { forumid: n.forum.id, sortorder: CREATED_DESC, page: 0, perpage: PER_FORUM },
          hint,
        ),
        {},
      ),
    ),
  );
  return news.flatMap((n, i) => discussionItems(api, n, { now: opts.now, list: lists[i]?.discussions ?? [] }));
}

type NewsForum = { forum: RawForum; course: Course };

/** One forums call for all courses; up to MAX_FORUMS news forums (one discussions call each) within the budget. */
async function newsForums(api: MoodleApi, courses: readonly Course[], budget: CallBudget): Promise<NewsForum[]> {
  const byId = new Map(courses.map((c) => [c.id, c]));
  const forums = await softly(
    api.call<RawForum[]>(FORUMS_FN, { courseids: courses.map((c) => c.id) }),
    [] as RawForum[],
  );
  const candidates: NewsForum[] = [];
  for (const forum of Array.isArray(forums) ? forums : []) {
    const course = byId.get(Number(forum.course));
    if (forum.type === 'news' && forum.id && course) candidates.push({ forum, course });
  }
  candidates.sort((a, b) => (a.forum.id ?? 0) - (b.forum.id ?? 0));
  return rotated(candidates)
    .slice(0, MAX_FORUMS)
    .filter(() => budget.take());
}

interface StateCm {
  id?: string | number;
  module?: string;
  sectionnumber?: number;
  uservisible?: boolean;
}

/** The course's first forum of section 0: where Moodle creates the announcements forum. */
function firstSectionForum(state: unknown): number | null {
  let parsed: { cm?: StateCm[] } | null = null;
  try {
    parsed = typeof state === 'string' ? JSON.parse(state) : (state as { cm?: StateCm[] } | null);
  } catch {
    return null;
  }
  const cm = (parsed?.cm ?? []).find((c) => c.module === 'forum' && c.sectionnumber === 0 && c.uservisible !== false);
  const id = Number(cm?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Web channel: listing every forum of every course costs a page per course and the forum type is only on a forum's
 * own page, so take each course's first section-0 forum (course structure: one ajax batch for all courses), and keep
 * those whose page says they are announcement forums. Each costs its view page, which the discussion list reuses.
 */
async function webNewsForums(api: MoodleApi, courses: readonly Course[], budget: CallBudget): Promise<NewsForum[]> {
  const states = await Promise.all(
    courses.map((c) => softly(api.call<unknown>('core_courseformat_get_state', { courseid: c.id }), null)),
  );
  const candidates = courses.flatMap((course, i) => {
    const cmid = firstSectionForum(states[i]);
    return cmid === null ? [] : [{ course, cmid }];
  });
  const picked = rotated(candidates)
    .slice(0, MAX_FORUMS)
    .filter(() => budget.take(WEB_CALLS_PER_FORUM));
  const found = await Promise.all(
    picked.map(async ({ course, cmid }) => {
      const list = await softly(api.call<RawForum[]>(FORUMS_FN, { courseids: [course.id] }, { cmid }), []);
      const forum = Array.isArray(list) ? list.find((f) => f.type === 'news' && f.id) : undefined;
      return forum ? [{ forum, course }] : [];
    }),
  );
  return found.flat();
}
