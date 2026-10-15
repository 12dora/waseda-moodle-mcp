import { fmt } from '../../time';
import type { CourseUpdate, DueList } from '../../types';
import { assemble, type Entry, oneLine, plural } from './common';

interface UpdatesResult {
  updates: CourseUpdate[];
  stats: DueList['sweep'];
}

const byNewest = (a: CourseUpdate, b: CourseUpdate) => Date.parse(b.at) - Date.parse(a.at);

function changeLabel(u: CourseUpdate): string {
  if (u.change === 'new') return 'NEW';
  return u.what.length > 0 ? `updated (${u.what.join(', ')})` : 'updated';
}

function updateLine(u: CourseUpdate): string {
  return `- ${changeLabel(u)} [${u.modname}] ${oneLine(u.name, 80)} (cmid ${u.cmid}) — ${fmt(u.at)} — ${u.url}`;
}

/** Courses ordered by their newest change, items newest first inside each course. */
function groupByCourse(updates: CourseUpdate[]): Array<{ head: CourseUpdate; items: CourseUpdate[] }> {
  const groups = new Map<number, CourseUpdate[]>();
  for (const u of [...updates].sort(byNewest)) groups.set(u.courseId, [...(groups.get(u.courseId) ?? []), u]);
  return [...groups.values()].flatMap((items) => (items[0] ? [{ head: items[0], items }] : []));
}

function statsLine({ stats }: UpdatesResult): string {
  const stale =
    stats.stale > 0 ? `; ${plural(stats.stale, 'course')} not refreshed yet, so results may be incomplete` : '';
  const at = stats.checkedAt ? ` (last check ${fmt(stats.checkedAt)})` : '';
  return `Checked ${plural(stats.checked, 'course')}${at}${stale}.`;
}

export function renderCourseUpdates(r: UpdatesResult, sinceDays: number): string {
  if (r.updates.length === 0) {
    return `No new or changed course content in the last ${plural(sinceDays, 'day')}. ${statsLine(r)}`;
  }
  const entries = groupByCourse(r.updates).flatMap<Entry>(({ head, items }) => [
    { text: '' },
    { text: `## ${oneLine(head.courseName, 80)} (course_id ${head.courseId})` },
    ...items.map<Entry>((u) => ({ text: updateLine(u), item: true })),
  ]);
  return assemble({
    head: [`${plural(r.updates.length, 'change')} in the last ${plural(sinceDays, 'day')}. Times are JST.`],
    entries,
    footer: ['Open an item with get_activity (cmid) to read it; its file links work with get_file.', statsLine(r)],
    hint: 'pass course_id or a smaller since_days',
  });
}

export function renderMyCourses(ids: number[] | null): string {
  if (ids === null) {
    return 'Back to the automatic course suggestion. list_courses shows which courses it picks; ask the user to confirm them.';
  }
  return `Saved: ${plural(ids.length, 'course')} (course_id ${ids.join(', ')}) are now the course selection (This term's courses). get_due_items, list_courses, search_course_content and get_course_updates use this selection; pass course_id to look at another course.`;
}
