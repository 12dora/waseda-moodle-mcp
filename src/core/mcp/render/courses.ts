import { fmt, fmtDue } from '../../time';
import type { Course, CourseOutline, ModuleSummary, SearchHit } from '../../types';
import { assemble, type Entry, oneLine, plural } from './common';

/** Date keys that are deadlines (midnight reads as the previous day 24:00); the rest are plain times. */
const DEADLINE_KEY = /due|clos|cutoff|cut-off|end|until|deadline/i;

export function renderCourses(courses: Course[]): string {
  if (courses.length === 0) return 'No courses found for this filter.';
  const entries = courses.map<Entry>((c) => {
    const progress = c.progress !== null ? ` — progress ${Math.round(c.progress)}%` : '';
    return {
      text: `- ${oneLine(c.name, 90)} — course_id ${c.id}${progress}${c.hidden ? ' — hidden' : ''}`,
      item: true,
    };
  });
  return assemble({ head: [`${plural(courses.length, 'course')}:`], entries, hint: 'narrow with classification' });
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
    return `No matches${q} in ${scope}. Try other words, or list_courses with classification "all".`;
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
