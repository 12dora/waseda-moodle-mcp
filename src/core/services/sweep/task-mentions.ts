/** A date written in a task module's own text belongs to that module, never to a separate "mentioned" item. */

import type { DueItem } from '../../types';

export interface TaskMentionInput {
  /** Text items found in the course text and announcements. */
  mentions: readonly DueItem[];
  calendar: readonly DueItem[];
  activities: readonly DueItem[];
  /** cmids of the task modules (assign, quiz, questionnaire...) of the scope courses. */
  taskCmids: ReadonlySet<number>;
}

export interface TaskMentionResult {
  calendar: DueItem[];
  activities: DueItem[];
  /** Mentions of task modules that nothing else lists (cmid, real name and kind set). */
  standalone: DueItem[];
  /** Mentions of anything else (labels, sections, announcements...). */
  rest: DueItem[];
}

/** The listed item takes the mentioned date; its source stays, the evidence says where the date came from. */
function withMention(item: DueItem, mention: DueItem): DueItem {
  return {
    ...item,
    dueAt: mention.dueAt,
    midnightDue: mention.midnightDue,
    overdue: mention.overdue,
    evidence: mention.evidence,
    sourceUrl: mention.sourceUrl,
  };
}

function indexByCmid(items: readonly DueItem[]): Map<number, number> {
  const out = new Map<number, number>();
  items.forEach((it, i) => {
    if (it.cmid !== null && !out.has(it.cmid)) out.set(it.cmid, i);
  });
  return out;
}

/** Gives the item of `mention.cmid` in `list` the mentioned date; false when `list` has no such item. */
function fill(list: DueItem[], at: ReadonlyMap<number, number>, mention: DueItem): boolean {
  const i = mention.cmid === null ? undefined : at.get(mention.cmid);
  const item = i === undefined ? undefined : list[i];
  if (i === undefined || !item) return false;
  if (!item.dueAt) list[i] = withMention(item, mention);
  return true;
}

/**
 * Per task module only its first mention counts: it fills the date of the calendar / activity item of that cmid
 * when that has none, is dropped when the item already has a deadline, and is emitted on its own when nothing lists the module.
 */
export function attachTaskMentions(input: TaskMentionInput): TaskMentionResult {
  const calendar = [...input.calendar];
  const activities = [...input.activities];
  const calendarAt = indexByCmid(calendar);
  const activityAt = indexByCmid(activities);
  const standalone: DueItem[] = [];
  const rest: DueItem[] = [];
  const handled = new Set<number>();
  for (const m of input.mentions) {
    if (m.cmid === null || !input.taskCmids.has(m.cmid)) {
      rest.push(m);
      continue;
    }
    if (handled.has(m.cmid)) continue;
    handled.add(m.cmid);
    if (!fill(calendar, calendarAt, m) && !fill(activities, activityAt, m)) standalone.push(m);
  }
  return { calendar, activities, standalone, rest };
}
