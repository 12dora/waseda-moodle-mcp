import type { DayNote, Timetable, TimetableClass, TimetableDay, TimetableSource } from '../../types';
import { assemble, type Entry, oneLine } from './common';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HOME_CAMPUS = '早稲田';
const SOURCE_MARK: Record<TimetableSource, string> = {
  syllabus: '',
  moodle: ' (from Moodle attendance)',
  user: ' (set by user)',
};

const monthDay = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;
const dayLabel = (d: TimetableDay) => `${WEEKDAYS[d.weekday - 1] ?? ''} ${monthDay(d.date)}`;

function noteText(n: DayNote): string {
  switch (n.kind) {
    case 'closed':
      return `No classes: ${n.name}`;
    case 'winter-break':
      return 'No classes: winter break';
    case 'term-break':
      return 'No classes: term break';
    case 'held':
      return `Classes held: ${n.name}`;
    case 'swap':
      return `Follows the ${WEEKDAY_NAMES[n.weekday - 1] ?? ''} schedule (振替)`;
  }
}

const isClosure = (n: DayNote) => n.kind === 'closed' || n.kind === 'winter-break' || n.kind === 'term-break';

function classLine(c: TimetableClass): string {
  const where = [c.classroom, c.campus && c.campus !== HOME_CAMPUS ? c.campus : null].filter(Boolean).join(', ');
  const detail = [c.periods + (c.night ? ' evening' : ''), where].filter(Boolean).join(', ');
  return `- ${c.start}–${c.end} ${oneLine(c.courseName, 70)} (${detail})${SOURCE_MARK[c.source]} course_id ${c.courseId}`;
}

/** `empty` = how to say a day has no class: "no known classes" while some course times are still unknown. */
function dayEntries(d: TimetableDay, empty: string): Entry[] {
  const notes = d.notes.map(noteText);
  const paren = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  if (d.classes.length > 0) {
    return [{ text: `${dayLabel(d)} —${paren}` }, ...d.classes.map<Entry>((c) => ({ text: classLine(c), item: true }))];
  }
  // a closure note already says "No classes"
  const text = d.notes.some(isClosure) ? notes.join('; ') : `${empty}${paren}`;
  return [{ text: `${dayLabel(d)} — ${text}`, item: true }];
}

// ------------------------------------------------------------------ break runs

const BREAK_TEXT = { 'term-break': 'term break', 'winter-break': 'winter break' } as const;

/** A class-free day whose only note is a break: such days are printed as one run, not one by one. */
function breakKind(d: TimetableDay | undefined): keyof typeof BREAK_TEXT | null {
  const only = d?.notes.length === 1 && d.classes.length === 0 ? d.notes[0] : undefined;
  return only?.kind === 'term-break' || only?.kind === 'winter-break' ? only.kind : null;
}

/** Consecutive days of the same break form one run; every other day is a run of its own. */
function runsOf(days: TimetableDay[]): TimetableDay[][] {
  const runs: TimetableDay[][] = [];
  for (const d of days) {
    const run = runs.at(-1);
    const kind = breakKind(d);
    if (run && kind !== null && breakKind(run[0]) === kind) run.push(d);
    else runs.push([d]);
  }
  return runs;
}

function runEntries(run: TimetableDay[], empty: string): Entry[] {
  const [first] = run;
  const last = run.at(-1);
  const kind = breakKind(first);
  if (run.length < 2 || !first || !last || kind === null) return run.flatMap((d) => dayEntries(d, empty));
  return [{ text: `${monthDay(first.date)}–${monthDay(last.date)}: no classes (${BREAK_TEXT[kind]})`, item: true }];
}

// ------------------------------------------------------------------ footer

const names = (list: Array<{ courseName: string; courseId: number }>) =>
  oneLine(list.map((c) => `${oneLine(c.courseName, 50)} (course_id ${c.courseId})`).join('; '), 500);

/** The separate list, grouped by what the course is (the label follows `kind`, not only `alsoInClass`). */
const UNSCHEDULED_GROUPS = [
  { kind: 'on-demand', alsoInClass: false, label: 'On-demand' },
  { kind: 'on-demand', alsoInClass: true, label: 'On-demand (also meets in class)' },
  { kind: 'no-fixed-time', alsoInClass: false, label: 'No weekly class (intensive or other)' },
  { kind: 'no-fixed-time', alsoInClass: true, label: 'Intensive (also meets in class)' },
] as const;

function onDemandLines(t: Timetable): string[] {
  return UNSCHEDULED_GROUPS.flatMap(({ kind, alsoInClass, label }) => {
    const list = t.onDemand.filter((c) => c.kind === kind && c.alsoInClass === alsoInClass);
    return list.length > 0 ? [`${label}: ${names(list)}.`] : [];
  });
}

function unknownLines(t: Timetable): string[] {
  const pending = t.unknown.filter((c) => c.reason === 'pending');
  const other = t.unknown.filter((c) => c.reason !== 'pending');
  const out: string[] = [];
  if (pending.length > 0) out.push(`Time unknown (not loaded yet, ask again to retry): ${names(pending)}.`);
  if (other.length > 0) {
    out.push(`Time unknown (can be set with set_course_schedule once the user says it): ${names(other)}.`);
  }
  return out;
}

function footer(t: Timetable): string[] {
  const out = [...onDemandLines(t), ...unknownLines(t)];
  if (t.approximate) out.push('Dates outside AY2026: holidays and term ends are estimated.');
  if (t.scopeMode === 'auto')
    out.push("Using suggested courses; confirm the course selection with set_my_courses (This term's courses).");
  return out;
}

export function renderTimetable(t: Timetable): string {
  const range = t.from === t.to ? t.from : `${t.from} to ${t.to}`;
  return assemble({
    head: [`Timetable ${range}. Times are JST; periods follow the official 時限 table.`],
    entries: runsOf(t.days).flatMap((run) => runEntries(run, t.unknown.length > 0 ? 'no known classes' : 'no classes')),
    footer: footer(t),
    hint: 'ask for fewer days',
  });
}
