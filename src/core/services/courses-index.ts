/** Compact per-course search index (cached in the store) and the matcher that runs over it. */

import type { CourseOutline, ModuleSummary, SearchHit } from '../types';

interface IndexModule {
  c: number; // cmid
  n: string; // name
  t: string; // modname
  u: string | null; // url
  f?: Array<[name: string, url: string, size: number, mime: string | null]>;
}

interface IndexSection {
  i: number; // section id
  k: number; // section number
  n: string; // name
  m: IndexModule[];
}

export interface CourseIndexPayload {
  v: 1;
  name: string;
  s: IndexSection[];
}

export interface ScoredHit {
  /** 2 = every term matched the module/file names, 1 = some terms needed the section name. */
  score: number;
  hit: SearchHit;
}

function indexModule(m: ModuleSummary): IndexModule {
  const e: IndexModule = { c: m.cmid, n: m.name, t: m.modname, u: m.url };
  if (m.files.length) e.f = m.files.map((f) => [f.name, f.url, f.size, f.mime]);
  return e;
}

/** Drops summaries, dates and completion; keeps what search needs to answer. */
export function buildIndex(outline: CourseOutline): CourseIndexPayload {
  const sections: IndexSection[] = outline.sections
    .filter((s) => s.modules.length > 0)
    .map((s) => ({ i: s.id, k: s.number, n: s.name, m: s.modules.map(indexModule) }));
  return { v: 1, name: outline.course.name, s: sections };
}

export function parseCourseIndex(json: string): CourseIndexPayload | null {
  try {
    const p = JSON.parse(json) as CourseIndexPayload;
    return p && p.v === 1 && Array.isArray(p.s) ? p : null;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase();

export function parseQuery(query: string): string[] {
  return norm(query).split(/\s+/).filter(Boolean);
}

/** 0 = no match; 2 = all terms in module/file names; 1 = some terms only matched the section name. */
function scoreModule(m: IndexModule, sectionText: string, terms: string[]): number {
  const text = norm([m.n, ...(m.f ?? []).map((f) => f[0])].join(' '));
  const inModule = terms.filter((t) => text.includes(t)).length;
  const inEither = terms.filter((t) => text.includes(t) || sectionText.includes(t)).length;
  if (inEither !== terms.length) return 0;
  return inModule === terms.length ? 2 : 1;
}

function toHit(course: { id: number; name: string }, sectionName: string, m: IndexModule): SearchHit {
  return {
    courseId: course.id,
    courseName: course.name,
    sectionName,
    module: {
      cmid: m.c,
      name: m.n,
      modname: m.t,
      url: m.u,
      visible: true,
      dates: {},
      completed: null,
      files: (m.f ?? []).map(([name, url, size, mime]) => ({ name, url, size, mime, modified: null })),
    },
  };
}

/** AND over whitespace-separated terms against module name + file names + section name. One pass. */
export function searchIndex(
  payload: CourseIndexPayload,
  course: { id: number; name: string },
  terms: string[],
): ScoredHit[] {
  const out: ScoredHit[] = [];
  for (const s of payload.s) {
    const sectionText = norm(s.n);
    for (const m of s.m) {
      const score = scoreModule(m, sectionText, terms);
      if (score) out.push({ score, hit: toHit(course, s.n, m) });
    }
  }
  return out;
}
