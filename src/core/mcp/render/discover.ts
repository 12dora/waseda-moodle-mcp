import type {
  CourseSearchResult,
  IncompleteActivity,
  IncompleteList,
  MyPost,
  MyPostsList,
} from '../../services/discover/types';
import { fmt } from '../../time';
import { assemble, type Entry, oneLine, plural } from './common';

const KIND_LABELS: Readonly<Record<string, string>> = { millvi: 'on-demand video' };

/** Moodle's module name, with the plain wording where the plugin name says little. */
const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

function todo(a: IncompleteActivity): string {
  if (a.conditions.length > 0) return `to do: ${oneLine(a.conditions.join('; '), 80)}`;
  return a.completion === 'manual' ? 'to do: mark as done' : 'not done';
}

function activityLine(a: IncompleteActivity): string {
  const parts = [`- [${kindLabel(a.kind)}] ${oneLine(a.name, 90)} (cmid ${a.cmid})`, todo(a)];
  if (a.sectionName) parts.push(oneLine(a.sectionName, 40));
  if (a.hidden) parts.push('hidden or not available yet');
  if (a.url) parts.push(a.url);
  return parts.join(' — ');
}

function skippedLine(r: IncompleteList): string[] {
  const budget = r.skippedCourses.filter((s) => s.reason === 'budget');
  const unreadable = r.skippedCourses.filter((s) => s.reason === 'unreadable');
  const name = (s: { courseName: string; courseId: number }) => `${oneLine(s.courseName, 50)} (${s.courseId})`;
  const lines: string[] = [];
  if (budget.length > 0) {
    lines.push(`Not checked (too many courses for one call; repeat with course_id): ${budget.map(name).join('; ')}.`);
  }
  if (unreadable.length > 0) lines.push(`Could not be read: ${unreadable.map(name).join('; ')}.`);
  return lines;
}

export function renderIncomplete(r: IncompleteList): string {
  const open = r.courses.reduce((n, c) => n + c.activities.length, 0);
  const filter = r.kinds ? ` of kind ${r.kinds.map(kindLabel).join(', ')}` : '';
  const entries = r.courses.flatMap<Entry>((c) => [
    { text: '' },
    { text: `## ${oneLine(c.courseName, 80)} (course_id ${c.courseId}) — ${c.done}/${c.total} done` },
    ...c.activities.map<Entry>((a) => ({ text: activityLine(a), item: true })),
  ]);
  const head =
    open === 0
      ? `Nothing left to do${filter}: every activity with completion tracking is done.`
      : `${plural(open, 'activity', 'activities')}${filter} not done in ${plural(r.courses.length, 'course')}.`;
  return assemble({
    head: [head],
    entries,
    footer: [
      ...skippedLine(r),
      'Opening a resource or video in Moodle can mark it as viewed or done, so open one only when the user wants that; get_activity (cmid) shows its details.',
    ],
    hint: 'pass course_id or kinds',
  });
}

function postLine(p: MyPost): string {
  const where = [p.courseName, p.forumName, p.discussionSubject].filter((s) => s !== '').map((s) => oneLine(s, 50));
  const when = p.postedAt ? fmt(p.postedAt) : 'no date';
  const kind = p.isDiscussionStart ? 'started' : 'reply';
  const lines = [
    `- ${when} — ${kind}: ${oneLine(p.postSubject, 60)}`,
    `  ${where.join(' > ')} (discussion_id ${p.discussionId}, post_id ${p.postId})`,
  ];
  if (p.excerpt) lines.push(`  "${oneLine(p.excerpt, 120)}"`);
  return lines.join('\n');
}

export function renderMyPosts(r: MyPostsList): string {
  if (r.posts.length === 0) {
    return r.page === 0 ? 'You have no forum posts in this selection.' : `No posts on page ${r.page}.`;
  }
  const footer = [
    'Open a thread with get_discussion (discussion_id; forum_type forum, or hsuforum for an Advanced Forum). Times are JST; posts are in the order Moodle lists them (most recently changed first).',
  ];
  if (r.nextPage !== null) footer.push(`More posts: call again with page ${r.nextPage}.`);
  return assemble({
    head: [`${plural(r.posts.length, 'post')} on page ${r.page}.`],
    entries: r.posts.map<Entry>((p) => ({ text: postLine(p), item: true })),
    footer,
    hint: 'page through with page',
  });
}

export function renderCourseSearch(r: CourseSearchResult): string {
  if (r.courses.length === 0) return `No courses match "${oneLine(r.query, 60)}".`;
  const entries = r.courses.map<Entry>((c) => ({
    text: `- ${oneLine(c.name, 90)} [${oneLine(c.shortName, 40)}] — course_id ${c.id}${c.category ? ` — ${oneLine(c.category, 40)}` : ''} — ${c.enrolled ? 'enrolled' : 'not enrolled'} — ${c.url}`,
    item: true,
  }));
  const footer = ['Courses you are not enrolled in cannot be opened with the other tools.'];
  if (r.nextPage !== null) footer.push(`More matches: call again with page ${r.nextPage}.`);
  return assemble({
    head: [`${r.total} course${r.total === 1 ? '' : 's'} match "${oneLine(r.query, 60)}" (page ${r.page}).`],
    entries,
    footer,
    hint: 'page through with page',
  });
}
