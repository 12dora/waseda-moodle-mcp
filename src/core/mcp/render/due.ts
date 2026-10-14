import { deadlineMs, fmt, fmtDue } from '../../time';
import type { DueItem, DueList } from '../../types';
import { clip, hardCap, MAX_TEXT_CHARS, oneLine, plural } from './common';

const JST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86_400_000;
/** Undated activities beyond this many are summarised; they mostly are trackerless material, not tasks. */
const MAX_NO_DEADLINE_LINES = 5;
/** Calendar items of courses outside the user's selection: shown last and briefly. */
const MAX_OTHER_COURSE_LINES = 5;

type DueGroup = 'Overdue' | 'Today' | 'Tomorrow' | 'Next 7 days' | 'Later' | 'No deadline';
/** Order on screen. */
const DISPLAY_ORDER: DueGroup[] = ['Overdue', 'Today', 'Tomorrow', 'Next 7 days', 'Later', 'No deadline'];
/** Order in which groups claim the character budget: what is nearest wins over old or distant items. */
const BUDGET_ORDER: DueGroup[] = ['Today', 'Tomorrow', 'Overdue', 'Next 7 days', 'Later', 'No deadline'];

const jstDay = (ms: number) => Math.floor((ms + JST_OFFSET_MS) / DAY_MS);

function dayGroup(diff: number): DueGroup {
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return diff <= 7 ? 'Next 7 days' : 'Later';
}

/** The instant the line shows: a deadline at 00:00 counts as the day before; opening times are plain. */
function shownMs(item: DueItem): number | null {
  if (item.dueAt) return deadlineMs(item.dueAt);
  return item.opensAt ? Date.parse(item.opensAt) : null;
}

function dueGroup(item: DueItem, now: number): DueGroup {
  if (item.overdue) return 'Overdue';
  if (!item.dueAt && !item.notOpenYet) return 'No deadline'; // already open, nothing to hand in by a date
  const ms = shownMs(item);
  return ms === null ? 'Later' : dayGroup(jstDay(ms) - jstDay(now));
}

function dueWhen(i: DueItem): string {
  if (!i.dueAt && i.source === 'activity' && !i.notOpenYet) return 'no deadline set in Moodle';
  if (i.dueAt) return `due ${fmtDue(i.dueAt)}${i.notOpenYet && i.opensAt ? `, opens ${fmt(i.opensAt)}` : ''}`;
  if (!i.opensAt) return 'no deadline';
  return i.notOpenYet ? `opens ${fmt(i.opensAt)}` : `open since ${fmt(i.opensAt)}, no deadline`;
}

/** Text items carry the quoted snippet and where it was found, so the model can check the date itself. */
function evidenceLine(i: DueItem): string {
  if (!i.evidence && i.source !== 'text') return '';
  const quote = i.evidence ? ` «${oneLine(i.evidence, 160)}»` : '';
  const where = i.sourceUrl ? ` ${i.sourceUrl}` : '';
  return quote || where ? `\n  evidence:${quote}${where}` : '';
}

function dueLine(i: DueItem): string {
  const cm = i.cmid !== null ? ` (cmid ${i.cmid})` : '';
  const late = i.overdue ? ' — OVERDUE' : '';
  const fresh = i.isNew ? ' — NEW' : '';
  const verify = i.source === 'text' || i.evidence ? ' — mentioned in course text — verify' : '';
  const head = `- [${i.kind}] ${oneLine(i.name, 90)} — ${oneLine(i.courseName, 60)} — ${dueWhen(i)}`;
  return `${head}${verify}${late}${fresh}${cm}${evidenceLine(i)}`;
}

/** Newest first: NEW ones, then the higher cmid (added later). Stable otherwise. */
function newestFirst(items: readonly DueItem[]): DueItem[] {
  const newness = (i: DueItem) => (i.isNew ? 1 : 0);
  return [...items].sort((a, b) => newness(b) - newness(a) || (b.cmid ?? 0) - (a.cmid ?? 0));
}

/** The items a group may list: the "No deadline" group shows only its newest few. */
function listable(group: DueGroup, items: DueItem[]): DueItem[] {
  return group === 'No deadline' ? newestFirst(items).slice(0, MAX_NO_DEADLINE_LINES) : items;
}

interface Section {
  heading: string;
  lines: string[];
  dropped: number;
  capped: number; // items not even offered to the budget (the "No deadline" cap)
}

/** Overdue-but-open items may use at most this share of what is left, so upcoming ones are never crowded out. */
const OVERDUE_SHARE = 0.5;

/** Fills the budget group by group in BUDGET_ORDER, so a long overdue list cannot push out today's items. */
function fitSections(groups: Map<DueGroup, DueItem[]>, budget: number): Map<DueGroup, Section> {
  const out = new Map<DueGroup, Section>();
  let left = budget;
  for (const g of BUDGET_ORDER) {
    const items = groups.get(g) ?? [];
    if (items.length === 0) continue;
    const offered = listable(g, items);
    const section: Section = {
      heading: `## ${g} (${items.length})`,
      lines: [],
      dropped: 0,
      capped: items.length - offered.length,
    };
    let allowance = g === 'Overdue' ? Math.floor(left * OVERDUE_SHARE) : left;
    allowance -= section.heading.length + 2;
    left -= section.heading.length + 2;
    for (const item of offered) {
      const line = dueLine(item);
      if (line.length + 1 > allowance) {
        section.dropped++;
        continue;
      }
      section.lines.push(line);
      allowance -= line.length + 1;
      left -= line.length + 1;
    }
    out.set(g, section);
  }
  return out;
}

function closedSummary(closed: DueItem[]): string {
  const names = closed.map((i) => `${oneLine(i.name, 40)} (${oneLine(i.courseName, 30)})`).join(', ');
  return clip(`${plural(closed.length, 'closed item')} no longer accepted: ${names}`, 400);
}

function dueFooter(list: DueList): string[] {
  const { scope, sweep } = list;
  const lines = [
    scope.mode === 'auto'
      ? `Using suggested courses (${scope.courseIds.length}); not confirmed by the user yet. Ask which courses they attend, then confirm with set_my_courses.`
      : `Your courses: ${scope.courseIds.length}.`,
  ];
  if (sweep.checked > 0 || sweep.stale > 0) {
    const stale =
      sweep.stale > 0 ? `, ${plural(sweep.stale, 'course')} not refreshed yet (course-page tasks may be missing)` : '';
    const at = sweep.checkedAt ? `, last check ${fmt(sweep.checkedAt)}` : '';
    lines.push(`Course pages checked: ${sweep.checked}${stale}${at}.`);
  }
  if (list.otherCourses.length > 0) {
    lines.push(
      `${plural(list.otherCourses.length, 'calendar deadline')} in enrolled courses outside your selection ${list.otherCourses.length === 1 ? 'is' : 'are'} listed under "Other enrolled courses"; if one of those courses matters, add it with set_my_courses.`,
    );
  }
  if (scope.otherCount > 0) {
    lines.push(
      `${plural(scope.otherCount, 'other enrolled course')} not included (pass course_id to look at one; list_courses with scope "all" shows them).`,
    );
  }
  return lines;
}

/** Final group: calendar items of enrolled courses outside the scope (never dropped, but at most a few lines). */
function otherCoursesSection(list: DueList): string[] {
  const items = list.otherCourses.filter((i) => !i.closed);
  if (items.length === 0) return [];
  const shown = items.slice(0, MAX_OTHER_COURSE_LINES).map(dueLine);
  const more = items.length - shown.length;
  return ['', `## Other enrolled courses (${items.length})`, ...shown, ...(more > 0 ? [`… ${more} more`] : [])];
}

export function renderDueList(list: DueList): string {
  const open = list.items.filter((i) => !i.closed);
  const closed = list.items.filter((i) => i.closed);
  const window = `${list.windowFrom.slice(0, 10)} and ${list.windowTo.slice(0, 10)}`;
  const head = [
    'Due items. Times are JST; a deadline at 00:00 is shown as the previous day 24:00.',
    list.items.length === 0
      ? `Nothing outstanding ${list.otherCourses.length > 0 ? 'in your courses ' : ''}between ${window}.`
      : `${plural(list.items.length, 'item')} between ${window}:`,
  ];
  const notes: string[] = [];
  if (list.truncated) notes.push('(More events exist than could be loaded; narrow with course_id or days_ahead.)');
  notes.push(...dueFooter(list));
  const tail = closed.length > 0 ? [closedSummary(closed)] : [];

  const now = Date.parse(list.generatedAt);
  const groups = new Map<DueGroup, DueItem[]>();
  for (const item of open) {
    const g = dueGroup(item, now);
    groups.set(g, [...(groups.get(g) ?? []), item]);
  }
  const other = otherCoursesSection(list);
  const reserved = [...head, ...notes, ...tail, ...other].join('\n').length + 160;
  const sections = fitSections(groups, MAX_TEXT_CHARS - reserved);

  const body: string[] = [];
  for (const g of DISPLAY_ORDER) {
    const s = sections.get(g);
    if (!s) continue;
    body.push('', s.heading, ...s.lines);
    if (s.dropped > 0) body.push(`… ${s.dropped} more (use course_id or a smaller days_ahead)`);
    if (s.capped > 0) body.push(`… ${s.capped} more without a deadline (see the console's Due page)`);
  }
  return hardCap([...head, ...body, ...other, ...notes, ...tail].join('\n'));
}
