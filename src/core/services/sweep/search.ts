/** Case-insensitive NFKC AND-search over module / file / section names of the snapshots. */

import { fromTs } from '../../time';
import type { Course, IsoJst, SearchHit } from '../../types';
import type { CourseSnapshot, SnapModule } from './snapshot';

export interface ScoredHit {
  /** 2 = every term matched the module/file names, 1 = some terms needed the section name. */
  score: number;
  hit: SearchHit;
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase();

export function parseQuery(query: string): string[] {
  return norm(query).split(/\s+/).filter(Boolean);
}

/** 0 = no match; 2 = all terms in module/file names; 1 = some terms only matched the section name. */
function scoreModule(m: SnapModule, sectionText: string, terms: readonly string[]): number {
  const text = norm([m.n, ...(m.f ?? []).map((f) => f[0])].join(' '));
  const inModule = terms.filter((t) => text.includes(t)).length;
  const inEither = terms.filter((t) => text.includes(t) || sectionText.includes(t)).length;
  if (inEither !== terms.length) return 0;
  return inModule === terms.length ? 2 : 1;
}

function isoDates(d: Record<string, number> | undefined): Record<string, IsoJst> {
  const out: Record<string, IsoJst> = {};
  for (const [k, ts] of Object.entries(d ?? {})) {
    const iso = fromTs(ts);
    if (iso) out[k] = iso;
  }
  return out;
}

function toHit(course: Course, sectionName: string, m: SnapModule): SearchHit {
  return {
    courseId: course.id,
    courseName: course.name,
    sectionName,
    module: {
      cmid: m.c,
      name: m.n,
      modname: m.t,
      url: m.u,
      visible: m.v !== 0,
      dates: isoDates(m.d),
      completed: m.k === undefined ? null : m.k === 1,
      files: (m.f ?? []).map(([name, url, size, mime]) => ({ name, url, size, mime, modified: null })),
    },
  };
}

/** One pass over a snapshot. */
export function searchSnapshot(snap: CourseSnapshot, course: Course, terms: readonly string[]): ScoredHit[] {
  const out: ScoredHit[] = [];
  for (const s of snap.s) {
    const sectionText = norm(s.n);
    for (const m of s.m) {
      const score = scoreModule(m, sectionText, terms);
      if (score) out.push({ score, hit: toHit(course, s.n, m) });
    }
  }
  return out;
}
