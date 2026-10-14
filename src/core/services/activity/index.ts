/**
 * getActivity: one activity (by cmid) in detail — assignment, quiz, forum, page, url, label, book and
 * everything else (resource, folder, …) as generic content. At most ~5 Moodle calls.
 */

import type { MoodleApi, ServiceContext } from '../../context';
import { MoodleError, NotFound } from '../../errors';
import { htmlToMarkdown } from '../../html';
import type { ActivityDetail, DiscussionSummary, ForumDetail } from '../../types';
import { type ForumType, fetchDiscussions, fetchForums } from '../forums';
import { type ActivityInfo, type CourseModuleInfo, courseNameMap, getCourseModule, pickLang } from '../shared';
import { loadAssign } from './assign';
import { loadContent } from './content';
import { loadQuiz } from './quiz';

async function loadForum(
  api: MoodleApi,
  cm: CourseModuleInfo,
  forumType: ForumType,
  info: ActivityInfo,
): Promise<ForumDetail> {
  const refs = await fetchForums(api, forumType, [cm.courseId]);
  const ref = refs.find((r) => r.cmid === cm.cmid || r.forumId === cm.instance);
  if (!ref) throw new NotFound(`Forum ${cm.cmid} was not found or is not visible.`);
  let discussions: DiscussionSummary[] = [];
  if (ref.numDiscussions !== 0) {
    // the forum itself is still worth showing when its discussions cannot be listed
    discussions = await fetchDiscussions(api, ref, info.courseName, 10).catch((e: unknown) => {
      if (e instanceof MoodleError) return [];
      throw e;
    });
  }
  return {
    type: 'forum',
    cmid: cm.cmid,
    forumId: ref.forumId,
    forumType,
    courseId: cm.courseId,
    courseName: info.courseName,
    name: ref.name,
    url: info.url,
    description: htmlToMarkdown(pickLang(ref.intro, info.lang), { maxChars: 6000 }),
    dueAt: ref.dueAt,
    discussions,
  };
}

export async function getActivity(ctx: ServiceContext, cmid: number): Promise<ActivityDetail> {
  const api = await ctx.moodle();
  const [cm, names] = await Promise.all([getCourseModule(api, cmid), courseNameMap(ctx)]);
  const info: ActivityInfo = {
    courseName: names.get(cm.courseId) ?? `Course ${cm.courseId}`,
    url: `${api.baseUrl}/mod/${cm.modname}/view.php?id=${cmid}`,
    lang: ctx.user.lang,
  };

  switch (cm.modname) {
    case 'assign':
      return loadAssign(api, cm, info);
    case 'quiz':
      return loadQuiz(api, cm, info);
    case 'forum':
    case 'hsuforum':
      return loadForum(api, cm, cm.modname, info);
    default:
      return loadContent(api, cm, { ...info, courseId: cm.courseId, modname: cm.modname });
  }
}
