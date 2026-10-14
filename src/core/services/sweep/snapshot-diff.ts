/** Stamps "first seen" / "updated" on a freshly built snapshot by comparing it with the previous one. */

import { type CourseSnapshot, REFETCH_AREAS, type SnapModule, type SnapText } from './snapshot';

export interface DiffEnv {
  now: number;
  /** Update areas per cmid reported by core_course_get_updates_since for this refetch. */
  updates: ReadonlyMap<number, readonly string[]>;
}

const fileKey = (m: SnapModule) => (m.f ?? []).map((f) => `${f[0]}\u0000${f[1]}`).join('\u0001');
const datesKey = (m: SnapModule) => JSON.stringify(m.d ?? null);

function changedAreas(old: SnapModule, cur: SnapModule, reported: readonly string[] | undefined): string[] {
  const what = new Set<string>();
  if (old.n !== cur.n || datesKey(old) !== datesKey(cur)) what.add('configuration');
  if (fileKey(old) !== fileKey(cur)) what.add('contentfiles');
  for (const area of reported ?? []) if (REFETCH_AREAS.has(area)) what.add(area);
  return [...what];
}

function stampModule(cur: SnapModule, old: SnapModule | undefined, env: DiffEnv): void {
  if (!old) {
    cur.s = env.now;
    return;
  }
  if (old.s !== undefined) cur.s = old.s;
  const what = changedAreas(old, cur, env.updates.get(cur.c));
  if (what.length > 0) {
    cur.a = env.now;
    cur.w = what;
  } else if (old.a !== undefined) {
    cur.a = old.a;
    if (old.w) cur.w = old.w;
  }
}

function stampText(cur: SnapText, old: SnapText | undefined, now: number): void {
  if (!old || old.x !== cur.x) cur.s = now;
  else if (old.s !== undefined) cur.s = old.s;
}

/** Mutates `snap` (freshly built, owned by the caller). Without a previous snapshot nothing counts as new. */
export function stampChanges(snap: CourseSnapshot, prev: CourseSnapshot | null, env: DiffEnv): CourseSnapshot {
  if (!prev) return snap;
  const oldMods = new Map<number, SnapModule>();
  for (const s of prev.s) for (const m of s.m) oldMods.set(m.c, m);
  for (const s of snap.s) for (const m of s.m) stampModule(m, oldMods.get(m.c), env);
  const oldTexts = new Map(prev.x.map((t) => [t.r, t]));
  for (const t of snap.x) stampText(t, oldTexts.get(t.r), env.now);
  return snap;
}
