/** "What did teachers add": new / changed modules noticed by the sweep. */

import { isoJst } from '../../time';
import type { Course, CourseUpdate } from '../../types';
import type { CourseSnapshot, SnapModule } from './snapshot';

/** When and how a module changed since `sinceMs`; null when it did not. */
function change(m: SnapModule, sinceMs: number): { kind: 'new' | 'updated'; at: number; what: string[] } | null {
  if (m.v === 0) return null;
  if (m.s !== undefined && m.s >= sinceMs) return { kind: 'new', at: m.s, what: [] };
  if (m.a !== undefined && m.a >= sinceMs) return { kind: 'updated', at: m.a, what: m.w ?? [] };
  return null;
}

export function courseUpdates(course: Course, snap: CourseSnapshot, sinceMs: number): CourseUpdate[] {
  const out: CourseUpdate[] = [];
  for (const m of snap.s.flatMap((sec) => sec.m)) {
    const c = change(m, sinceMs);
    if (!c) continue;
    out.push({
      courseId: course.id,
      courseName: course.name,
      cmid: m.c,
      name: m.n,
      modname: m.t,
      change: c.kind,
      what: c.what,
      at: isoJst(c.at),
      url: m.u ?? course.url,
    });
  }
  return out;
}
