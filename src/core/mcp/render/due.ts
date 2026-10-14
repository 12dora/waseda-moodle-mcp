import { fmt } from '../../time';
import type { DueItem, DueList } from '../../types';
import { assemble, type Entry, oneLine, plural } from './common';

const JST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86_400_000;

type DueGroup = 'Overdue' | 'Today' | 'Tomorrow' | 'Next 7 days' | 'Later';
const DUE_GROUPS: DueGroup[] = ['Overdue', 'Today', 'Tomorrow', 'Next 7 days', 'Later'];

const jstDay = (ms: number) => Math.floor((ms + JST_OFFSET_MS) / DAY_MS);

function dayGroup(diff: number): DueGroup {
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return diff <= 6 ? 'Next 7 days' : 'Later';
}

function dueGroup(item: DueItem, now: number): DueGroup {
  if (item.overdue) return 'Overdue';
  const iso = item.dueAt ?? item.opensAt;
  if (!iso) return 'Later';
  let ms = Date.parse(iso);
  if (item.dueAt && item.midnightDue) ms -= 60_000; // 00:00 reads as the previous day's 24:00
  return dayGroup(jstDay(ms) - jstDay(now));
}

function dueWhen(i: DueItem): string {
  if (i.dueAt) return `due ${fmt(i.dueAt)}${i.notOpenYet && i.opensAt ? `, opens ${fmt(i.opensAt)}` : ''}`;
  return i.opensAt ? `opens ${fmt(i.opensAt)}` : 'no deadline';
}

function lateMark(i: DueItem): string {
  if (i.closed) return ' — CLOSED (no longer accepted)';
  return i.overdue ? ' — OVERDUE' : '';
}

function dueLine(i: DueItem): string {
  const cm = i.cmid !== null ? ` (cmid ${i.cmid})` : '';
  const late = lateMark(i);
  return `- [${i.kind}] ${oneLine(i.name, 90)} — ${oneLine(i.courseName, 60)} — ${dueWhen(i)}${late}${cm}`;
}

export function renderDueList(list: DueList, now: number = Date.now()): string {
  const window = `${list.windowFrom.slice(0, 10)} and ${list.windowTo.slice(0, 10)}`;
  const head = [
    'Due items. Times are JST; a deadline at 00:00 is shown as the previous day 24:00.',
    list.items.length === 0
      ? `Nothing outstanding between ${window}.`
      : `${plural(list.items.length, 'item')} between ${window}:`,
  ];
  const entries: Entry[] = [];
  for (const g of DUE_GROUPS) {
    const items = list.items.filter((i) => dueGroup(i, now) === g);
    if (items.length === 0) continue;
    entries.push({ text: '' }, { text: `## ${g} (${items.length})` });
    for (const i of items) entries.push({ text: dueLine(i), item: true });
  }
  const footer: string[] = [];
  if (list.hiddenCourseCount > 0) {
    footer.push(`(${plural(list.hiddenCourseCount, 'item')} from hidden courses not shown.)`);
  }
  if (list.truncated) footer.push('(More events exist than could be loaded; narrow with course_id or days_ahead.)');
  return assemble({ head, entries, footer, hint: 'use course_id or a smaller days_ahead' });
}
