/**
 * list_my_posts: the user's own forum posts, Moodle's own order (most recently changed first), from the posts page
 * of the user's profile (`/mod/forum/user.php`). The page is a plain listing: it has no unread state and no
 * mark-as-read action, so reading it does not mark any post read (the discussion and its ajax post list do).
 */

import type { MoodleApi, ServiceContext } from '../../context';
import { settleChannel } from '../../moodle/web/channel';
import { webSessionOf } from '../activity/web';
import { clampInt } from '../shared';
import { optionalPositiveInt } from '../validate';
import { parsePostsPage } from './posts-page';
import type { MyPostsList } from './types';

const MAX_PAGE = 1000;
/** Asked for per page (Moodle's default is 5); the pager states the size actually used. */
const PER_PAGE = 20;

function pathOf(api: MoodleApi, courseId: number | undefined, page: number): string {
  const query = new URLSearchParams({ id: String(api.moodleUserId) });
  if (courseId !== undefined) query.set('course', String(courseId));
  query.set('perpage', String(PER_PAGE));
  if (page > 0) query.set('page', String(page));
  return `/mod/forum/user.php?${query.toString()}`;
}

/** One page of the user's own posts (web channel only; the web service has no equivalent). */
export async function listMyPosts(
  ctx: ServiceContext,
  opts: { courseId?: number; page?: number } = {},
): Promise<MyPostsList> {
  const courseId = optionalPositiveInt(opts.courseId, 'course_id');
  const page = clampInt(opts.page, 0, 0, MAX_PAGE);
  const api = await ctx.moodle();
  await settleChannel(api); // a fresh client may still fall back from the token channel to the session
  const web = webSessionOf(api, `${api.baseUrl}/mod/forum/user.php?id=${api.moodleUserId}`);
  const parsed = parsePostsPage((await web.page(pathOf(api, courseId, page))).html);
  return { posts: parsed.posts, page, nextPage: parsed.linkedPages.includes(page + 1) ? page + 1 : null };
}
