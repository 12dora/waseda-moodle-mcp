/** My courses view helpers: status groups (contract §6.1 buckets) and schedule classification. */

import { type DueBucket, dueBucket } from '../../../src/core/services/due-groups';
import type { CourseOverviewItem, CourseSchedule, DueItem } from '../api/types';

const BUCKET_ORDER: readonly DueBucket[] = ['overdue', 'todo', 'draft', 'done'];

/** Items in status groups (overdue, to do, draft & in progress, submitted), service order kept; closed unsubmitted items are left out. */
export function groupByBucket(items: readonly DueItem[]): Array<{ bucket: DueBucket; items: DueItem[] }> {
  const out = new Map<DueBucket, DueItem[]>();
  for (const it of items) {
    const bucket = dueBucket(it);
    if (bucket === null) continue;
    const list = out.get(bucket);
    if (list) list.push(it);
    else out.set(bucket, [it]);
  }
  return BUCKET_ORDER.flatMap((bucket) => {
    const list = out.get(bucket);
    return list ? [{ bucket, items: list }] : [];
  });
}

type ScheduleKind = 'weekly' | 'on-demand' | 'no-fixed-time' | 'unknown';

/** Weekly slots win (a hybrid course shows its slots); otherwise the listing; nothing known → 'unknown'. */
export function scheduleKind(schedule: CourseSchedule): ScheduleKind {
  if (schedule.slots.length > 0) return 'weekly';
  if (schedule.listing) return schedule.listing;
  return 'unknown';
}

/** Class courses first, then the others; order within each kind kept (stable sort). */
export function classFirst(courses: readonly CourseOverviewItem[]): CourseOverviewItem[] {
  const rank = (c: CourseOverviewItem) => (c.kind === 'class' ? 0 : 1);
  return [...courses].sort((a, b) => rank(a) - rank(b));
}
