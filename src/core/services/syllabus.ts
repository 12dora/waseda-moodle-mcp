/**
 * Term lookup from the public Waseda syllabus (www.wsl.waseda.jp): idnumber -> pKey -> detail page -> 学期曜日時限.
 * Moodle cannot tell 秋クォーター from 冬クォーター (all class courses span 9/21-3/31), the syllabus can.
 * Policy: on-demand only (enrolled class courses), sequential, <= 3 uncached lookups per call, results (also "none")
 * cached globally for the academic year. robots.txt disallows crawlers, so there is no search-form scraping.
 */

import type { ServiceContext } from '../context';
import { decodeEntities } from '../html';
import { isoJst, nowMs } from '../time';

const DETAIL_URL = 'https://www.wsl.waseda.jp/syllabus/JAA104.php';
const USER_AGENT = 'waseda-moodle-mcp/0.1 (+syllabus term lookup)';
const FETCH_TIMEOUT_MS = 8000;
const MAX_UNCACHED_PER_CALL = 3;
const CACHE_TTL_MS = 365 * 86_400_000;
const EMPTY_MARKER = '参照可能なシラバス情報はありません';
const ERROR_MARKER = 'システムエラー';
const TERM_RE = /^(春学期|秋学期|春クォーター|夏クォーター|秋クォーター|冬クォーター|通年|集中)/;

export interface SyllabusInfo {
  pKey: string;
  year: number; // academic year of the idnumber the lookup was made for
  term: string | null; // 春クォーター, 秋学期, 通年, ...; null when the cell has no recognised term
  dayPeriod: string | null; // e.g. "月１-２"
  instructors: string[];
  master: boolean; // taken from the 総合日本語 master page: day/period covers several sections
}

export type SyllabusParse =
  | { status: 'ok'; term: string | null; dayPeriod: string | null; instructors: string[] }
  | { status: 'empty' | 'error' };

// ------------------------------------------------------------------ pKey

interface IdnumberParts {
  year: number;
  courseKey: string; // 10 chars
  classCode: string; // 2 chars
}

function splitIdnumber(idnumber: string): IdnumberParts | null {
  if (idnumber.includes('ZZ') || !/^\d{4}[0-9A-Za-z]{12}$/.test(idnumber)) return null; // ZZ = non-class course
  return { year: Number(idnumber.slice(0, 4)), courseKey: idnumber.slice(4, 14), classCode: idnumber.slice(14) };
}

function buildPKey(p: IdnumberParts & { school: string }): string {
  // creative / advanced science schools use a rewritten second copy of the key in public URLs
  const dKey = p.school === '27' || p.school === '28' ? `26${p.courseKey.slice(2)}` : p.courseKey;
  return `${p.courseKey}${p.classCode}${p.year}${dKey}${p.school}`;
}

/** 28-char detail key built from a 16-char class idnumber; null for non-class / malformed idnumbers. */
export function syllabusPKey(idnumber: string): string | null {
  const parts = splitIdnumber(idnumber);
  return parts ? buildPKey({ ...parts, school: parts.courseKey.slice(0, 2) }) : null;
}

// ------------------------------------------------------------------ HTML

function cellText(html: string, label: string): string | null {
  const m = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(html);
  if (!m?.[1]) return null;
  return decodeEntities(m[1].replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTermCell(text: string): { term: string | null; dayPeriod: string | null } {
  const term = TERM_RE.exec(text)?.[1] ?? null;
  const rest = term ? text.slice(term.length).trim() : text;
  return { term, dayPeriod: rest || null };
}

/** `学期曜日時限` (ja) -> term + day/period; `担当教員` -> instructors. */
export function parseSyllabusTerm(html: string): SyllabusParse {
  if (html.includes(ERROR_MARKER)) return { status: 'error' };
  const cell = cellText(html, '学期曜日時限');
  if (cell === null) return { status: html.includes(EMPTY_MARKER) ? 'empty' : 'error' };
  const instructors = (cellText(html, '担当教員') ?? '')
    .split(/[、／,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { status: 'ok', ...splitTermCell(cell), instructors };
}

// ------------------------------------------------------------------ current terms

/**
 * Terms in session on `nowMs` (JST). Derived from the AY2026 official calendar (春Q 4/11-6/3, 夏Q 6/4-7/29, 秋Q
 * 10/1-11/21, 冬Q 11/23-2/2) with the breaks folded into the neighbouring term, and applied to every year:
 * Apr 1-Jun 3 春Q, Jun 4-Sep 20 夏Q, Sep 21-Nov 21 秋Q, Nov 22-Mar 31 冬Q. 通年 always; 集中 never (see termFit).
 */
export function currentTerms(at: number): ReadonlySet<string> {
  const md = isoJst(at).slice(5, 10); // "MM-DD"
  const semester = md >= '04-01' && md < '09-21' ? '春学期' : '秋学期';
  let quarter = '冬クォーター';
  if (md >= '04-01' && md < '06-04') quarter = '春クォーター';
  else if (md >= '06-04' && md < '09-21') quarter = '夏クォーター';
  else if (md >= '09-21' && md < '11-22') quarter = '秋クォーター';
  return new Set([quarter, semester, '通年']);
}

export function inCurrentTerm(term: string | null, at: number): boolean {
  return term !== null && currentTerms(at).has(term);
}

/** 'unknown' for no term and for 集中 (intensive blocks): the lastaccess / calendar signals decide those. */
export function termFit(term: string | null, at: number): 'current' | 'not-current' | 'unknown' {
  if (term === null || term === '集中') return 'unknown';
  return inCurrentTerm(term, at) ? 'current' : 'not-current';
}

// ------------------------------------------------------------------ fetching

async function fetchDetail(pKey: string): Promise<SyllabusParse | null> {
  try {
    const res = await fetch(`${DETAIL_URL}?pKey=${pKey}&pLng=jp`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok ? parseSyllabusTerm(await res.text()) : null;
  } catch {
    return null;
  }
}

export interface LookupCourse {
  id: number;
  idnumber: string;
  name: string;
}

/** 総合日本語 sections have no per-class page; the master pages (class 99 = 秋, 98 = 春) carry the term. */
async function fetchMaster(parts: IdnumberParts, at: number): Promise<SyllabusInfo | null> {
  const courseKey = `${parts.courseKey.slice(0, 7)}999`;
  const fall = currentTerms(at).has('秋学期');
  for (const classCode of fall ? ['99', '98'] : ['98', '99']) {
    const pKey = buildPKey({ ...parts, courseKey, classCode, school: courseKey.slice(0, 2) });
    const page = await fetchDetail(pKey);
    if (page?.status === 'ok') return toInfo(pKey, parts.year, page, true);
  }
  return null;
}

type LookupResult = { cache: true; info: SyllabusInfo | null } | { cache: false };

/** `cache: false` = could not be determined (network / server problem): try again next time. */
async function fetchSyllabus(course: LookupCourse, at: number): Promise<LookupResult> {
  const parts = splitIdnumber(course.idnumber);
  if (!parts) return { cache: true, info: null };
  const pKey = buildPKey({ ...parts, school: parts.courseKey.slice(0, 2) });
  const page = await fetchDetail(pKey);
  if (!page || page.status === 'error') return { cache: false };
  if (page.status === 'ok') return { cache: true, info: toInfo(pKey, parts.year, page, false) };
  const isJapaneseMaster = parts.courseKey.startsWith('92') && course.name.startsWith('総合日本語');
  return { cache: true, info: isJapaneseMaster ? await fetchMaster(parts, at) : null };
}

function toInfo(
  pKey: string,
  year: number,
  page: Extract<SyllabusParse, { status: 'ok' }>,
  master: boolean,
): SyllabusInfo {
  return { pKey, year, term: page.term, dayPeriod: page.dayPeriod, instructors: page.instructors, master };
}

// ------------------------------------------------------------------ cache + lookup

type Cached = { info: SyllabusInfo | null; fresh: boolean };

function readCached(idnumber: string, row: { json: string; fetchedAt: number }, at: number): Cached | null {
  try {
    const info = JSON.parse(row.json) as SyllabusInfo | null;
    const year = Number(idnumber.slice(0, 4));
    const yearOk = info === null || info.year === year;
    return { info, fresh: yearOk && at - row.fetchedAt < CACHE_TTL_MS };
  } catch {
    return null;
  }
}

async function readCache(ctx: ServiceContext, idnumbers: string[], at: number): Promise<Map<string, Cached>> {
  const out = new Map<string, Cached>();
  try {
    for (const [idnumber, row] of await ctx.store.getSyllabusCache(idnumbers)) {
      const cached = readCached(idnumber, row, at);
      if (cached) out.set(idnumber, cached);
    }
  } catch {
    /* an unreadable cache only costs lookups */
  }
  return out;
}

/**
 * Term info per course id (`null` = unknown). Never throws: the scope must not depend on a third-party site.
 * `syllabusLookup: false` (kill switch) serves cached rows only and fetches nothing.
 */
export async function lookupTerms(
  ctx: ServiceContext,
  courses: LookupCourse[],
  opts: { syllabusLookup?: boolean } = {},
): Promise<Map<number, SyllabusInfo | null>> {
  const at = nowMs();
  const eligible = courses.filter((c) => splitIdnumber(c.idnumber));
  const cache = await readCache(
    ctx,
    eligible.map((c) => c.idnumber),
    at,
  );
  const result = new Map<number, SyllabusInfo | null>(courses.map((c) => [c.id, cache.get(c.idnumber)?.info ?? null]));
  if (opts.syllabusLookup === false) return result;

  const missing = eligible.filter((c) => !cache.get(c.idnumber)?.fresh).slice(0, MAX_UNCACHED_PER_CALL);
  for (const course of missing) {
    const found = await fetchSyllabus(course, at);
    if (!found.cache) continue;
    result.set(course.id, found.info);
    try {
      await ctx.store.putSyllabusCache(course.idnumber, JSON.stringify(found.info), at);
    } catch {
      /* best effort */
    }
  }
  return result;
}
