import type { Timetable, TimetableClass, TimetableDay } from '../../types';
import { assemble, type Entry, oneLine } from './common';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOME_CAMPUS = '早稲田';

const dayLabel = (d: TimetableDay) => `${WEEKDAYS[d.weekday - 1] ?? ''} ${d.date.slice(5, 7)}/${d.date.slice(8, 10)}`;

function classLine(c: TimetableClass): string {
  const where = [c.classroom, c.campus && c.campus !== HOME_CAMPUS ? c.campus : null].filter(Boolean).join(', ');
  const detail = [c.periods + (c.night ? ' evening' : ''), where].filter(Boolean).join(', ');
  return `- ${c.start}–${c.end} ${oneLine(c.courseName, 70)} (${detail}) course_id ${c.courseId}`;
}

function dayEntries(d: TimetableDay): Entry[] {
  const note = d.note ? ` (${d.note})` : '';
  if (d.classes.length === 0) return [{ text: `${dayLabel(d)} — no classes${note}`, item: true }];
  return [{ text: `${dayLabel(d)} —${note}` }, ...d.classes.map<Entry>((c) => ({ text: classLine(c), item: true }))];
}

const names = (list: Array<{ courseName: string; courseId: number }>) =>
  oneLine(list.map((c) => `${oneLine(c.courseName, 50)} (course_id ${c.courseId})`).join('; '), 500);

function footer(t: Timetable): string[] {
  const out: string[] = [];
  if (t.onDemand.length > 0) {
    out.push(`On-demand / no fixed weekly time (no start time to show): ${names(t.onDemand)}.`);
  }
  if (t.unknown.length > 0) {
    out.push(
      `Time unknown (no syllabus schedule found or not loaded yet; ask again to retry, the teacher or Moodle page may say): ${names(t.unknown)}.`,
    );
  }
  if (t.approximate) out.push('Dates outside AY2026: holidays and term ends are estimated.');
  if (t.scopeMode === 'auto')
    out.push('Using suggested courses; confirm which ones the user attends with set_my_courses.');
  return out;
}

export function renderTimetable(t: Timetable): string {
  const range = t.from === t.to ? t.from : `${t.from} to ${t.to}`;
  return assemble({
    head: [`Timetable ${range}. Times are JST; periods follow the official 時限 table.`],
    entries: t.days.flatMap(dayEntries),
    footer: footer(t),
    hint: 'ask for fewer days',
  });
}
