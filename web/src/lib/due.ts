import type { DueItem } from '../api/types';
import { DUE_GROUPS, type DueGroup, dueGroup } from './time';

/** Due page bucket: the date groups plus 'past' for handed-in items whose deadline has passed. */
export type DuePageGroup = DueGroup | 'past';

const DUE_PAGE_GROUPS: readonly DuePageGroup[] = [...DUE_GROUPS, 'past'];

/** Handed in (drafts / open attempts still count as outstanding). */
export function isSubmitted(item: DueItem): boolean {
  return item.submission?.status === 'submitted';
}

/** Still to hand in and still accepted: not submitted, not closed, and either dated or opening later. */
export function outstandingItems(items: DueItem[]): DueItem[] {
  return items.filter((it) => !isSubmitted(it) && !it.closed && (it.dueAt !== null || it.notOpenYet));
}

/** Without a deadline: already open → 'undated'; opening later → the day it opens (never a past group). */
function undatedGroup(it: DueItem, now: number): DuePageGroup {
  if (!it.notOpenYet) return 'undated';
  const g = dueGroup(it.opensAt, { now, deadline: false });
  return g === 'overdue' ? 'undated' : g;
}

/** A submitted item is never 'overdue': once its deadline has passed it goes to 'past'. */
function pageGroup(it: DueItem, now: number): DuePageGroup {
  const submitted = isSubmitted(it);
  if (!submitted && it.overdue) return 'overdue';
  if (!it.dueAt) return undatedGroup(it, now);
  const g = dueGroup(it.dueAt, { now });
  return submitted && g === 'overdue' ? 'past' : g;
}

/** Filters by course and buckets every item (submitted ones included) in DUE_PAGE_GROUPS order. */
export function groupDue(
  items: DueItem[],
  courseId: number | 'all',
  now: number,
): { groups: Array<{ group: DuePageGroup; items: DueItem[] }> } {
  const out = new Map<DuePageGroup, DueItem[]>();
  for (const it of items) {
    if (courseId !== 'all' && it.courseId !== courseId) continue;
    const g = pageGroup(it, now);
    const list = out.get(g);
    if (list) list.push(it);
    else out.set(g, [it]);
  }
  const groups = DUE_PAGE_GROUPS.flatMap((g) => {
    const list = out.get(g);
    return list ? [{ group: g, items: list }] : [];
  });
  return { groups };
}
