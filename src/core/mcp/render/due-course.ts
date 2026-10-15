import { countDue, type DueBucket, dueBucket } from '../../services/due-groups';
import type { DueItem, DueList } from '../../types';
import { hardCap, MAX_TEXT_CHARS, oneLine } from './common';
import { type DueView, dueLayout, dueLine } from './due';

interface CourseGroup {
  courseId: number;
  courseName: string;
  items: DueItem[];
}

interface CourseBlock {
  heading: string;
  keep: string[];
  done: string[];
}

/** Scope order first, then any extra course ids in the order they first appear. */
function coursesInScopeOrder(items: readonly DueItem[], scopeIds: readonly number[]): CourseGroup[] {
  const map = new Map<number, CourseGroup>();
  for (const item of items) {
    const g = map.get(item.courseId);
    if (g) g.items.push(item);
    else map.set(item.courseId, { courseId: item.courseId, courseName: item.courseName, items: [item] });
  }
  const out: CourseGroup[] = [];
  for (const id of scopeIds) {
    const g = map.get(id);
    if (!g) continue;
    out.push(g);
    map.delete(id);
  }
  for (const g of map.values()) out.push(g);
  return out;
}

function listedItems(items: readonly DueItem[]): DueItem[] {
  return items.filter((i) => dueBucket(i) !== null);
}

/** overdue, then draft, then todo (each in list order), submitted last. */
function splitByStatus(items: readonly DueItem[]): { keep: DueItem[]; done: DueItem[] } {
  const buckets: Record<DueBucket, DueItem[]> = {
    overdue: [],
    draft: [],
    todo: [],
    done: [],
  };
  for (const item of items) {
    const b = dueBucket(item);
    if (b) buckets[b].push(item);
  }
  return { keep: [...buckets.overdue, ...buckets.draft, ...buckets.todo], done: buckets.done };
}

function courseHeading(g: CourseGroup): string {
  const c = countDue(g.items);
  const counts = `overdue ${c.overdue} · to do ${c.todo} · draft ${c.draft} · submitted ${c.done}`;
  return `## ${oneLine(g.courseName, 80)} (course_id ${g.courseId}) — ${counts}`;
}

function courseBlock(g: CourseGroup): CourseBlock {
  const { keep, done } = splitByStatus(g.items);
  return { heading: courseHeading(g), keep: keep.map(dueLine), done: done.map(dueLine) };
}

function lineCost(s: string): number {
  return s.length + 1;
}

function headingCost(heading: string): number {
  return heading.length + 2;
}

function takeFitting(lines: readonly string[], budget: { left: number }): { shown: string[]; dropped: number } {
  const shown: string[] = [];
  for (const line of lines) {
    const cost = lineCost(line);
    if (cost > budget.left) return { shown, dropped: lines.length - shown.length };
    shown.push(line);
    budget.left -= cost;
  }
  return { shown, dropped: 0 };
}

function moreNote(n: number, view: DueView): string {
  const where = view.stdio ? 'all are in structuredContent' : "see the console's Assignments & deadlines page";
  return `… ${n} more (${where})`;
}

function moreCoursesLine(n: number, view: DueView): string {
  return view.stdio ? `… ${n} more courses` : `… ${n} more courses (see the console's My courses page)`;
}

function restCoursesCost(n: number, view: DueView): number {
  return n > 0 ? lineCost(moreCoursesLine(n, view)) : 0;
}

interface FittedCourse {
  heading: string;
  keep: string[];
  done: string[];
  dropped: number;
  note: string | null;
}

function popLine(lines: string[], budget: { left: number }): boolean {
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  lines.pop();
  budget.left += lineCost(last);
  return true;
}

/** Spend leftover on a "… N more" note, popping this course's lines until the note fits. */
function fitNote(row: FittedCourse, budget: { left: number }, view: DueView): void {
  if (row.dropped === 0) return;
  let n = row.dropped;
  while (lineCost(moreNote(n, view)) > budget.left) {
    if (!popLine(row.done, budget) && !popLine(row.keep, budget)) break;
    n++;
  }
  row.dropped = n;
  const note = moreNote(n, view);
  if (lineCost(note) > budget.left) return;
  budget.left -= lineCost(note);
  row.note = note;
}

function noteFloor(b: CourseBlock, view: DueView): number {
  const n = b.keep.length + b.done.length;
  return n > 0 ? lineCost(moreNote(n, view)) : 0;
}

/** Headings of as many courses as fit, then their overdue/draft/todo lines; leftover is reserved for later courses. */
function fitKeepRows(blocks: CourseBlock[], budget: { left: number }, view: DueView): FittedCourse[] {
  const rows: FittedCourse[] = [];
  for (const [i, b] of blocks.entries()) {
    const rest = restCoursesCost(blocks.length - i - 1, view);
    const floor = noteFloor(b, view);
    if (headingCost(b.heading) + floor + rest > budget.left) break;
    budget.left -= headingCost(b.heading) + floor;
    const inner = { left: budget.left - rest };
    const k = takeFitting(b.keep, inner);
    budget.left = inner.left + rest + (k.dropped === 0 ? floor : 0);
    rows.push({ heading: b.heading, keep: k.shown, done: [], dropped: k.dropped, note: null });
  }
  return rows;
}

function courseVisible(r: FittedCourse): boolean {
  return r.note !== null || r.keep.length > 0 || r.done.length > 0 || r.dropped === 0;
}

function courseLines(r: FittedCourse): string[] {
  const lines = ['', r.heading, ...r.keep, ...r.done];
  if (r.note) lines.push(r.note);
  return lines;
}

/** Keep overdue/draft/todo of every course that fits, then submitted lines; never spend past `budget`. */
function fitCourseBody(blocks: CourseBlock[], budget: number, view: DueView): string[] {
  const slot = { left: budget };
  const rows = fitKeepRows(blocks, slot, view);
  const skippedKeep = blocks.length - rows.length;
  slot.left -= restCoursesCost(skippedKeep, view);
  for (const [i, row] of rows.entries()) {
    const b = blocks[i];
    if (!b) continue;
    const floor = noteFloor(b, view);
    if (row.dropped === 0) slot.left -= floor;
    const d = takeFitting(b.done, slot);
    row.done = d.shown;
    row.dropped += d.dropped;
    slot.left += floor;
    fitNote(row, slot, view);
  }
  const shown = rows.filter(courseVisible);
  const skipped = blocks.length - shown.length;
  const out = shown.flatMap(courseLines);
  if (skipped > 0) out.push(moreCoursesLine(skipped, view));
  return out;
}

export function renderDueByCourse(list: DueList, view: DueView = {}): string {
  const layout = dueLayout(list, view);
  const groups = coursesInScopeOrder(listedItems(list.items), list.scope.courseIds);
  const reserved = [...layout.head, ...layout.notes, ...layout.tail, ...layout.other].join('\n').length + 160;
  const body = fitCourseBody(groups.map(courseBlock), MAX_TEXT_CHARS - reserved, view);
  return hardCap([...layout.head, ...body, ...layout.other, ...layout.notes, ...layout.tail].join('\n'));
}
