import type { CourseGrade, CourseGrades, GradeItem } from '../../types';
import { assemble, clip, oneLine } from './common';

function gradeItemLine(i: GradeItem): string {
  const range = i.range ? ` / ${i.range}` : '';
  const pct = i.percentage ? ` (${i.percentage})` : '';
  const weight = i.weight ? ` — weight ${i.weight}` : '';
  const fb = i.feedback ? ` — "${oneLine(i.feedback, 120)}"` : '';
  const cm = i.cmid !== null ? ` (cmid ${i.cmid})` : '';
  const name = oneLine(i.name, 80);
  const label = i.itemType === 'course' ? `**${name || 'Course total'}**` : name;
  return `- ${label}${cm}: ${i.grade ?? '-'}${range}${pct}${weight}${fb}`;
}

const gradeCourseLine = (c: CourseGrade) =>
  `- ${oneLine(c.courseName, 80)} (course_id ${c.courseId}): ${c.grade ?? '-'}`;

export function renderGrades(
  r: { overview: CourseGrade[]; note?: string } | { course: CourseGrades; note?: string },
): string {
  const footer = r.note ? [`Note: ${clip(r.note, 400)}`] : [];
  if ('overview' in r) {
    if (r.overview.length === 0) {
      const detail = r.note ? footer : ['Pass course_id to get_grades for per-course grades.'];
      return ['No course grade overview is available.', ...detail].join('\n');
    }
    return assemble({
      head: ['Grades per course (use get_grades with course_id for the items):'],
      entries: r.overview.map((c) => ({ text: gradeCourseLine(c), item: true })),
      footer,
      hint: 'pass course_id',
    });
  }
  const g = r.course;
  const head = [`Grades — ${oneLine(g.courseName, 100)} (course_id ${g.courseId})`];
  if (g.items.length === 0) head.push('No graded items yet.');
  const entries = g.items.map((i) => ({ text: gradeItemLine(i), item: true }));
  return assemble({ head, entries, footer, hint: 'only the first items are shown' });
}
