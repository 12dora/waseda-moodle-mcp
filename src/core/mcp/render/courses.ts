import { fmt, fmtDue } from '../../time';
import type { Course, CourseOutline, ModuleSummary, SearchHit } from '../../types';
import { assemble, type Entry, oneLine, plural } from './common';

/** Date keys that are deadlines (midnight reads as the previous day 24:00); the rest are plain times. */
const DEADLINE_KEY = /due|clos|cutoff|cut-off|end|until|deadline/i;

interface CoursesView {
  /** 'auto' = the user has not confirmed their courses yet; the list is a suggestion. */
  mode: 'mine' | 'auto';
  scope: 'mine' | 'all';
}

function courseLine(c: Course, view: CoursesView): string {
  const parts = [oneLine(c.name, 90), `course_id ${c.id}`];
  if (c.term) parts.push(oneLine(c.term, 30));
  if (c.lastAccess) parts.push(`last access ${fmt(c.lastAccess)}`);
  if (c.progress !== null) parts.push(`progress ${Math.round(c.progress)}%`);
  if (!c.mine && c.suggested && view.mode === 'mine') parts.push('suggested');
  return `- ${parts.join(' — ')}`;
}

function courseGroup(title: string, courses: Course[], view: CoursesView): Entry[] {
  if (courses.length === 0) return [];
  return [
    { text: '' },
    { text: `## ${title} (${courses.length})` },
    ...courses.map<Entry>((c) => ({ text: courseLine(c, view), item: true })),
  ];
}

/** Non-class courses (library, career, seminars…): names only, so they do not crowd the list. */
function otherEnrolled(courses: Course[]): Entry[] {
  if (courses.length === 0) return [];
  const names = oneLine(courses.map((c) => `${oneLine(c.name, 50)} (${c.id})`).join('; '), 1200);
  return [{ text: '' }, { text: `## Other enrolled (${courses.length})` }, { text: names, item: true }];
}

function coursesFooter({ mode, scope }: CoursesView): string[] {
  const lines: string[] = [];
  if (mode === 'auto') {
    lines.push(
      "These are suggestions, not confirmed yet: ask the user which courses they attend this term, then call set_my_courses with those course_ids to save the course selection (This term's courses).",
    );
  }
  if (scope === 'mine') lines.push('Pass scope "all" to see the other enrolled courses.');
  return lines;
}

export function renderCourses(courses: Course[], view: CoursesView): string {
  if (courses.length === 0) return 'No courses found for this filter.';
  const mine = courses.filter((c) => c.mine);
  const rest = courses.filter((c) => !c.mine);
  const entries = [
    ...courseGroup('Your courses', mine, view),
    ...courseGroup(
      'Other class courses',
      rest.filter((c) => c.kind === 'class'),
      view,
    ),
    ...otherEnrolled(rest.filter((c) => c.kind === 'other')),
  ];
  return assemble({
    head: [`${plural(courses.length, 'course')}. Times are JST.`],
    entries,
    footer: coursesFooter(view),
    hint: view.scope === 'all' ? 'use scope "mine" for only your courses' : 'the full list is in structuredContent',
  });
}

function moduleLine(m: ModuleSummary): string {
  const parts = Object.entries(m.dates).map(([k, v]) => `${k} ${DEADLINE_KEY.test(k) ? fmtDue(v) : fmt(v)}`);
  if (m.completed !== null) parts.push(m.completed ? 'done' : 'not done');
  if (m.files.length > 0) {
    const names = m.files.slice(0, 3).map((f) => oneLine(f.name, 40));
    parts.push(`files: ${names.join(', ')}${m.files.length > 3 ? ` +${m.files.length - 3}` : ''}`);
  }
  const extra = parts.length ? ` — ${parts.join(' — ')}` : '';
  return `- [${m.modname}] ${oneLine(m.name, 80)} (cmid ${m.cmid})${extra}`;
}

function sectionEntries(section: CourseOutline['sections'][number]): Entry[] {
  const modules = section.modules.filter((m) => m.visible);
  if (modules.length === 0) return [];
  const entries: Entry[] = [{ text: '' }, { text: `## ${section.number}. ${oneLine(section.name, 80) || 'Section'}` }];
  const summary = oneLine(section.summary, 200);
  if (summary) entries.push({ text: summary });
  for (const m of modules) entries.push({ text: moduleLine(m), item: true });
  return entries;
}

export function renderOutline(o: CourseOutline): string {
  const head = [`# ${oneLine(o.course.name, 100)} (course_id ${o.course.id})`, o.course.url];
  const entries = o.sections.flatMap(sectionEntries);
  if (entries.length === 0) head.push('No visible content.');
  return assemble({
    head,
    entries,
    footer: ['Use get_activity with a cmid for details; its file links work with get_file.'],
    hint: 'pass section to see one section',
  });
}

export function renderSearch(r: { hits: SearchHit[]; searchedCourses: number }, query?: string): string {
  const q = query ? ` for "${oneLine(query, 60)}"` : '';
  const scope = plural(r.searchedCourses, 'course');
  if (r.hits.length === 0) {
    return `No matches${q} in ${scope}. Try other words, or pass course_id for an enrolled course outside your selection (list_courses with scope "all" shows them).`;
  }
  const entries = r.hits.map<Entry>((h) => ({
    text: `- [${h.module.modname}] ${oneLine(h.module.name, 80)} (cmid ${h.module.cmid}) — ${oneLine(h.courseName, 50)} (course_id ${h.courseId}) — ${oneLine(h.sectionName, 40)}`,
    item: true,
  }));
  return assemble({
    head: [`${plural(r.hits.length, 'match', 'matches')}${q} in ${scope}:`],
    entries,
    hint: 'lower limit or pass course_id',
  });
}
