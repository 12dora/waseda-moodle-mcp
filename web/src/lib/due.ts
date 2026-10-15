import type { DueItem } from '../api/types';
import { DUE_GROUPS, type DueGroup, dueGroup } from './time';

/** Handed in: no longer outstanding, listed separately (drafts / open attempts still count as outstanding). */
export function isSubmitted(item: DueItem): boolean {
  return item.submission?.status === 'submitted';
}

export function outstandingItems(items: DueItem[]): DueItem[] {
  return items.filter((it) => !isSubmitted(it));
}

/** Splits by course filter into outstanding groups (in DUE_GROUPS order) and the submitted list. */
export function groupDue(
  items: DueItem[],
  courseId: number | 'all',
  now: number,
): { groups: Array<{ group: DueGroup; items: DueItem[] }>; submitted: DueItem[] } {
  const out = new Map<DueGroup, DueItem[]>();
  const submitted: DueItem[] = [];
  for (const it of items) {
    if (courseId !== 'all' && it.courseId !== courseId) continue;
    if (isSubmitted(it)) {
      submitted.push(it);
      continue;
    }
    const g = it.overdue ? 'overdue' : dueGroup(it.dueAt ?? it.opensAt, { now, deadline: it.dueAt !== null });
    const list = out.get(g);
    if (list) list.push(it);
    else out.set(g, [it]);
  }
  const groups = DUE_GROUPS.flatMap((g) => {
    const list = out.get(g);
    return list ? [{ group: g, items: list }] : [];
  });
  return { groups, submitted };
}
