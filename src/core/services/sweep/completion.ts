/** Cheap completion refresh: one `core_completion_get_activities_completion_status` call instead of a full refetch. */

import { type CourseSnapshot, completionFlag } from './snapshot';

export const COMPLETION_FN = 'core_completion_get_activities_completion_status';
/** `core_course_get_updates_since` areas that only change the completion flags of a module. */
export const COMPLETION_AREAS: ReadonlySet<string> = new Set(['completion', 'submissions']);

export interface RawCompletion {
  statuses?: Array<{ cmid?: number; state?: number; tracking?: number }> | null;
}

/** Sets (or clears) `k` of the snapshot modules from the statuses; mutates `snap`. */
export function applyCompletion(snap: CourseSnapshot, res: RawCompletion | null): void {
  const byCmid = new Map((res?.statuses ?? []).flatMap((s) => (s.cmid ? [[s.cmid, s] as const] : [])));
  for (const sec of snap.s) {
    for (const m of sec.m) {
      const st = byCmid.get(m.c);
      if (!st) continue;
      if (st.tracking === 0 || typeof st.state !== 'number') delete m.k;
      else m.k = completionFlag(st.state);
    }
  }
}
