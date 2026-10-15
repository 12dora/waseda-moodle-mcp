/** Compact per-course content snapshot (persisted as JSON in the Store). Short keys keep rows small. */

import { decodeEntities, htmlToMarkdown } from '../../html';
import type { RawContentFile, RawDate, RawModule, RawSection } from '../../moodle/raw-course';
import { findDeadlines } from './extract-text';

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

/** A deadline found in a text at fetch time: [deadline ms, evidence snippet, lead phrase]. */
type SnapMention = [ms: number, evidence: string, lead: string];

/** A piece of course text that mentions at least one deadline (extracted once, when the course is fetched). */
export interface SnapText {
  k: TextKind;
  r: string; // stable reference: "s<section id>" section summary, "m<cmid>" module description
  n: string; // where it was found (section or module name)
  u: string; // link to it
  x: string; // markdown, <= TEXT_MAX chars (older snapshots also re-parse it)
  h?: string; // hash of the whole scanned markdown (change detection); absent in older snapshots
  d?: SnapMention[]; // deadlines found in the whole text; absent in snapshots stored before extraction moved here
  s?: number; // first seen (ms)
}

export interface CourseSnapshot {
  v: 1;
  s: SnapSection[];
  x: SnapText[];
  z?: number; // approximate size (bytes) of the raw core_course_get_contents JSON
}

/** `core_course_get_updates_since` areas that change what a snapshot holds → full refetch. */
export const REFETCH_AREAS: ReadonlySet<string> = new Set(['configuration', 'contentfiles']);

const TEXT_MAX = 2000; // stored per text
const SCAN_MAX = 6000; // scanned per text for deadlines
const MAX_TEXTS = 120;
export const MENTIONS_PER_TEXT = 8; // upcoming deadlines kept per text (paid once per fetch)
const NAME_MAX = 160;
const DAY_MS = 86_400_000;
const MODULE_OVERHEAD = 350; // rough bytes of the raw JSON per module / per content file, besides its strings
const FILE_OVERHEAD = 300;

// ------------------------------------------------------------------ raw Moodle shapes (loose, boundary only)

export interface SnapshotEnv {
  baseUrl: string;
  now: number; // unix ms; deadlines in texts are extracted (year inferred) relative to it
}

// ------------------------------------------------------------------ mappers

const DATE_KEYS: Record<string, string> = {
  duedate: 'due',
  allowsubmissionsfromdate: 'opens',
  cutoffdate: 'cutoff',
  gradingduedate: 'gradingDue',
  timeopen: 'opens',
  timeclose: 'closes',
  timeavailablefrom: 'opens', // database
  timeavailableto: 'closes',
  deadline: 'due', // lesson
  available: 'opens',
  submissionstart: 'opens', // workshop
  submissionend: 'due',
  opendate: 'opens', // questionnaire
  closedate: 'closes',
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

/** Completion state (0 incomplete, 1 complete, 2 pass, 3 fail) → snapshot flag. */
export const completionFlag = (state: number): 0 | 1 => (state >= 1 ? 1 : 0);

function mapCompletion(m: RawModule): 0 | 1 | undefined {
  const data = m.completiondata;
  if (!data || m.completion === 0 || data.hascompletion === false || typeof data.state !== 'number') return undefined;
  return completionFlag(data.state);
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

const HAS_DIGIT = /[\d０-９]/;

/** 53-bit string hash (cyrb53): stable across runtimes, enough to tell two versions of a text apart. */
function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Keeps a text only when it mentions a deadline that is not already past (a day's grace); the mentions are stored
 * so requests need no re-parsing.
 */
function textSource(
  src: { k: TextKind; r: string; n: string; u: string },
  html: string | undefined,
  now: number,
): SnapText | null {
  if (!html || !HAS_DIGIT.test(html)) return null;
  const x = htmlToMarkdown(html, { maxChars: SCAN_MAX });
  const found = findDeadlines(x, now, { max: MENTIONS_PER_TEXT, from: now - DAY_MS });
  if (found.length === 0) return null;
  return { ...src, x: x.slice(0, TEXT_MAX), h: hashText(x), d: found.map((f) => [f.ms, f.evidence, f.lead]) };
}

function moduleText(raw: RawModule, mod: SnapModule, env: { section: string; now: number }): SnapText | null {
  const kind: TextKind = mod.t === 'label' ? 'label' : 'page-intro';
  const src = { k: kind, r: `m${mod.c}`, n: kind === 'label' ? env.section : mod.n, u: mod.u ?? '' };
  return textSource(src, raw.description, env.now);
}

/** Rough size of the raw JSON of a module (strings plus fixed overhead). */
const rawModuleSize = (r: RawModule) =>
  MODULE_OVERHEAD + (r.description?.length ?? 0) + (r.name?.length ?? 0) + (r.contents?.length ?? 0) * FILE_OVERHEAD;

function mapSection(raw: RawSection, env: SnapshotEnv, out: { texts: SnapText[]; size: number }): SnapSection | null {
  if (raw.uservisible === false) return null;
  const number = Number(raw.section ?? 0);
  const id = Number(raw.id ?? 0);
  const name = sectionName(raw.name, number);
  const sectionUrl = `${env.baseUrl}/course/section.php?id=${id}`;
  const modules: SnapModule[] = [];
  // The section id is stable; the number shifts when a section is inserted.
  const pending = textSource({ k: 'section', r: `s${id || number}`, n: name, u: sectionUrl }, raw.summary, env.now);
  if (pending) out.texts.push(pending);
  out.size += (raw.summary?.length ?? 0) + (raw.name?.length ?? 0);
  for (const r of raw.modules ?? []) {
    out.size += rawModuleSize(r);
    const mod = mapModule(r);
    if (!mod) continue;
    modules.push(mod);
    const t = moduleText(r, mod, { section: name, now: env.now });
    if (t) out.texts.push({ ...t, u: t.u || sectionUrl });
  }
  return { i: id, k: number, n: name, m: modules };
}

/** At most MAX_TEXTS texts: the later sections win (teachers append content as the term goes on); order is kept. */
const capTexts = (texts: SnapText[]): SnapText[] => texts.slice(-MAX_TEXTS);

/** Raw `core_course_get_contents` → snapshot (no first-seen stamps yet; see snapshot-diff.ts). */
export function buildSnapshot(raw: unknown, env: SnapshotEnv): CourseSnapshot {
  const out = { texts: [] as SnapText[], size: 0 };
  const sections: SnapSection[] = [];
  for (const s of Array.isArray(raw) ? (raw as RawSection[]) : []) {
    const mapped = mapSection(s, env, out);
    if (mapped) sections.push(mapped);
  }
  return { v: 1, s: sections, x: capTexts(out.texts), z: out.size };
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
