import { deadlineMs, fmt, fmtDue } from '../../time';
import type { DueItem, DueList } from '../../types';
import { clip, hardCap, MAX_TEXT_CHARS, oneLine, plural } from './common';

const JST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86_400_000;

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
  if (i.dueAt) return `due ${fmtDue(i.dueAt)}${i.notOpenYet && i.opensAt ? `, opens ${fmt(i.opensAt)}` : ''}`;
  if (!i.opensAt) return 'no deadline';
  return i.notOpenYet ? `opens ${fmt(i.opensAt)}` : `open since ${fmt(i.opensAt)}, no deadline`;
}

function dueLine(i: DueItem): string {
  const cm = i.cmid !== null ? ` (cmid ${i.cmid})` : '';
  const late = i.overdue ? ' — OVERDUE' : '';
  return `- [${i.kind}] ${oneLine(i.name, 90)} — ${oneLine(i.courseName, 60)} — ${dueWhen(i)}${late}${cm}`;
}

interface Section {
  heading: string;
  lines: string[];
  dropped: number;
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
    const section: Section = { heading: `## ${g} (${items.length})`, lines: [], dropped: 0 };
    let allowance = g === 'Overdue' ? Math.floor(left * OVERDUE_SHARE) : left;
    allowance -= section.heading.length + 2;
    left -= section.heading.length + 2;
    for (const item of items) {
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

export function renderDueList(list: DueList): string {
  const open = list.items.filter((i) => !i.closed);
  const closed = list.items.filter((i) => i.closed);
  const window = `${list.windowFrom.slice(0, 10)} and ${list.windowTo.slice(0, 10)}`;
  const head = [
    'Due items. Times are JST; a deadline at 00:00 is shown as the previous day 24:00.',
    list.items.length === 0
      ? `Nothing outstanding between ${window}.`
      : `${plural(list.items.length, 'item')} between ${window}:`,
  ];
  const notes: string[] = [];
  if (list.hiddenCourseCount > 0) {
    notes.push(`(${plural(list.hiddenCourseCount, 'item')} from hidden courses not shown.)`);
  }
  if (list.truncated) notes.push('(More events exist than could be loaded; narrow with course_id or days_ahead.)');
  const tail = closed.length > 0 ? [closedSummary(closed)] : [];

  const now = Date.parse(list.generatedAt);
  const groups = new Map<DueGroup, DueItem[]>();
  for (const item of open) {
    const g = dueGroup(item, now);
    groups.set(g, [...(groups.get(g) ?? []), item]);
  }
  const reserved = [...head, ...notes, ...tail].join('\n').length + 160;
  const sections = fitSections(groups, MAX_TEXT_CHARS - reserved);

  const body: string[] = [];
  for (const g of DISPLAY_ORDER) {
    const s = sections.get(g);
    if (!s) continue;
    body.push('', s.heading, ...s.lines);
    if (s.dropped > 0) body.push(`… ${s.dropped} more (use course_id or a smaller days_ahead)`);
  }
  return hardCap([...head, ...body, ...notes, ...tail].join('\n'));
}
