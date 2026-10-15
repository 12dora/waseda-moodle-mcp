import type { DueItem } from '../types';

export type DueBucket = 'overdue' | 'todo' | 'draft' | 'done';

export interface DueCounts {
  overdue: number;
  todo: number;
  draft: number;
  done: number;
}

/**
 * done = submission.status 'submitted'; overdue = item.overdue (drafts past due count here);
 * draft = status draft | in-progress | reopened; todo = other open items;
 * null = closed and not submitted (not actionable, not listed).
 */
export function dueBucket(item: DueItem): DueBucket | null {
  if (item.submission?.status === 'submitted') return 'done';
  if (item.closed) return null;
  if (item.overdue) return 'overdue';
  const status = item.submission?.status;
  if (status === 'draft' || status === 'in-progress' || status === 'reopened') return 'draft';
  return 'todo';
}

export function countDue(items: readonly DueItem[]): DueCounts {
  const counts: DueCounts = { overdue: 0, todo: 0, draft: 0, done: 0 };
  for (const item of items) {
    const bucket = dueBucket(item);
    if (bucket) counts[bucket]++;
  }
  return counts;
}
