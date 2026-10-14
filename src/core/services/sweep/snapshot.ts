/** Compact per-course content snapshot (persisted as JSON in the Store). Short keys keep rows small. */

import { decodeEntities, htmlToMarkdown } from '../../html';
import type { RawContentFile, RawDate, RawModule, RawSection } from '../../moodle/raw-course';

type SnapFile = [name: string, url: string, size: number, mime: string | null];

export interface SnapModule {
  c: number; // cmid
  t: string; // modname
  n: string; // name
  u: string | null; // url
  d?: Record<string, number>; // dates by key (due, opens, closes, cutoff...), unix seconds
  k?: 0 | 1; // completion: 1 done, 0 pending; absent = not tracked
  v?: 0; // hidden from the user's course page (absent = visible)
  f?: SnapFile[];
  s?: number; // first seen (ms); absent for modules already present at the first fetch
  a?: number; // last noticed update (ms)
  w?: string[]; // what changed at `a`
}

interface SnapSection {
  i: number; // section id
  k: number; // section number
  n: string;
  m: SnapModule[];
}

type TextKind = 'section' | 'label' | 'page-intro';

/** A piece of course text that may mention a deadline (kept only when it contains a digit). */
export interface SnapText {
  k: TextKind;
  r: string; // stable reference: "s<number>" section summary, "m<cmid>" module description
  n: string; // where it was found (section or module name)
  u: string; // link to it
  x: string; // markdown, <= TEXT_MAX chars
  s?: number; // first seen (ms)
}

export interface CourseSnapshot {
  v: 1;
  s: SnapSection[];
  x: SnapText[];
}

/** `core_course_get_updates_since` areas that change what a snapshot holds → full refetch. */
export const REFETCH_AREAS: ReadonlySet<string> = new Set(['configuration', 'contentfiles']);

const TEXT_MAX = 2000;
const MAX_TEXTS = 60;
const NAME_MAX = 160;

// ------------------------------------------------------------------ raw Moodle shapes (loose, boundary only)

export interface SnapshotEnv {
  baseUrl: string;
}

// ------------------------------------------------------------------ mappers

const DATE_KEYS: Record<string, string> = {
  duedate: 'due',
  allowsubmissionsfromdate: 'opens',
  cutoffdate: 'cutoff',
  gradingduedate: 'gradingDue',
  timeopen: 'opens',
  timeclose: 'closes',
};

function mapDates(raw: RawDate[] | null | undefined): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  let i = 0;
  for (const d of raw ?? []) {
    i++;
    if (!d.timestamp) continue;
    const key = d.dataid ? (DATE_KEYS[d.dataid] ?? d.dataid) : `date${i}`;
    out[key in out ? `${key}${i}` : key] = d.timestamp;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mapCompletion(m: RawModule): 0 | 1 | undefined {
  const data = m.completiondata;
  if (!data || m.completion === 0 || data.hascompletion === false || typeof data.state !== 'number') return undefined;
  return data.state >= 1 ? 1 : 0;
}

function mapFiles(contents: RawContentFile[] | null | undefined): SnapFile[] | undefined {
  const out: SnapFile[] = [];
  for (const c of contents ?? []) {
    if (c.type === 'file' && c.fileurl && c.filename)
      out.push([c.filename, c.fileurl, c.filesize ?? 0, c.mimetype || null]);
  }
  return out.length > 0 ? out : undefined;
}

function mapModule(raw: RawModule): SnapModule | null {
  if (raw.uservisible === false || !raw.id) return null;
  const m: SnapModule = {
    c: raw.id,
    t: raw.modname ?? '',
    n: decodeEntities(raw.name ?? '').slice(0, NAME_MAX),
    u: raw.url || null,
  };
  const d = mapDates(raw.dates);
  if (d) m.d = d;
  const k = mapCompletion(raw);
  if (k !== undefined) m.k = k;
  if (raw.visible === 0 || raw.visible === false) m.v = 0;
  const f = mapFiles(raw.contents);
  if (f) m.f = f;
  return m;
}

function sectionName(raw: string | undefined, number: number): string {
  return decodeEntities(raw ?? '') || (number === 0 ? 'General' : `Section ${number}`);
}

function textSource(src: { k: TextKind; r: string; n: string; u: string }, html: string | undefined): SnapText | null {
  if (!html || !/\d/.test(html)) return null;
  const x = htmlToMarkdown(html, { maxChars: TEXT_MAX });
  return /\d/.test(x) ? { ...src, x } : null;
}

function moduleText(raw: RawModule, mod: SnapModule, section: string): SnapText | null {
  const kind: TextKind = mod.t === 'label' ? 'label' : 'page-intro';
  const src = { k: kind, r: `m${mod.c}`, n: kind === 'label' ? section : mod.n, u: mod.u ?? '' };
  return textSource(src, raw.description);
}

function mapSection(raw: RawSection, env: SnapshotEnv, texts: SnapText[]): SnapSection | null {
  if (raw.uservisible === false) return null;
  const number = Number(raw.section ?? 0);
  const id = Number(raw.id ?? 0);
  const name = sectionName(raw.name, number);
  const sectionUrl = `${env.baseUrl}/course/section.php?id=${id}`;
  const modules: SnapModule[] = [];
  const pending = textSource({ k: 'section', r: `s${number}`, n: name, u: sectionUrl }, raw.summary);
  if (pending) texts.push(pending);
  for (const r of raw.modules ?? []) {
    const mod = mapModule(r);
    if (!mod) continue;
    modules.push(mod);
    const t = moduleText(r, mod, name);
    if (t) texts.push({ ...t, u: t.u || sectionUrl });
  }
  return { i: id, k: number, n: name, m: modules };
}

/** Raw `core_course_get_contents` → snapshot (no first-seen stamps yet; see snapshot-diff.ts). */
export function buildSnapshot(raw: unknown, env: SnapshotEnv): CourseSnapshot {
  const texts: SnapText[] = [];
  const sections: SnapSection[] = [];
  for (const s of Array.isArray(raw) ? (raw as RawSection[]) : []) {
    const mapped = mapSection(s, env, texts);
    if (mapped) sections.push(mapped);
  }
  return { v: 1, s: sections, x: texts.slice(0, MAX_TEXTS) };
}

export function parseSnapshot(json: string): CourseSnapshot | null {
  try {
    const p = JSON.parse(json) as CourseSnapshot;
    return p && p.v === 1 && Array.isArray(p.s) && Array.isArray(p.x) ? p : null;
  } catch {
    return null;
  }
}

export function snapshotCmids(snap: CourseSnapshot): Set<number> {
  const out = new Set<number>();
  for (const s of snap.s) for (const m of s.m) out.add(m.c);
  return out;
}
