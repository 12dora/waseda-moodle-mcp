/**
 * Term lookup from the public Waseda syllabus (www.wsl.waseda.jp): idnumber -> pKey -> detail page -> 学期曜日時限.
 * Moodle cannot tell 秋クォーター from 冬クォーター (all class courses span 9/21-3/31), the syllabus can.
 * Policy: on-demand only (enrolled class courses), sequential, <= 3 fetches and one 3 s deadline per call, results (also
 * "none") cached globally for the academic year, failures cached as "unknown" for an hour. robots.txt disallows
 * crawlers, so there is no search-form scraping.
 */

import type { ServiceContext } from '../context';
import { decodeEntities } from '../html';
import { isoJst, nowMs } from '../time';

const DETAIL_URL = 'https://www.wsl.waseda.jp/syllabus/JAA104.php';
const USER_AGENT = 'waseda-moodle-mcp/0.1 (+syllabus term lookup)';
/** One deadline for every fetch of a lookup call, so a hanging site costs a request at most this much. */
const LOOKUP_DEADLINE_MS = 3000;
const MAX_FETCHES_PER_CALL = 3;
const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 365 * DAY_MS;
/** Server errors, timeouts and システムエラー pages: remembered as "unknown" so a blocked / hanging site is not retried per request. */
const UNKNOWN_TTL_MS = 3_600_000;
const UNKNOWN_JSON = '{"unknown":true}';
/** A term counts as current this long before it starts (pre-course material and deadlines appear earlier). */
const TERM_LOOKAHEAD_MS = 14 * DAY_MS;
const EMPTY_MARKER = '参照可能なシラバス情報はありません';
const TERM_RE = /^(春学期|秋学期|春クォーター|夏クォーター|秋クォーター|冬クォーター|通年|集中)/;

export interface SyllabusInfo {
  pKey: string;
  year: number; // academic year of the idnumber the lookup was made for
  term: string | null; // 春クォーター, 秋学期, 通年, ...; null when the cell has no recognised term
  dayPeriod: string | null; // e.g. "月１-２"
  instructors: string[];
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

/** Academic year containing `at` (JST): January-March still belong to the year that began the previous April. */
export function academicYear(at: number): number {
  const iso = isoJst(at);
  return Number(iso.slice(0, 4)) - (Number(iso.slice(5, 7)) <= 3 ? 1 : 0);
}

/**
 * 'unknown' for no term and for 集中 (intensive blocks): the lastaccess / calendar signals decide those.
 * `year` = the course's academic year (idnumber); a term only fits when that is the current one (null = not known).
 * A term is current from 14 days before it starts.
 */
export function termFit(
  term: string | null,
  at: number,
  year: number | null = null,
): 'current' | 'not-current' | 'unknown' {
  if (term === null || term === '集中') return 'unknown';
  const fits = (t: number) => inCurrentTerm(term, t) && (year === null || year === academicYear(t));
  return fits(at) || fits(at + TERM_LOOKAHEAD_MS) ? 'current' : 'not-current';
}

// ------------------------------------------------------------------ fetching

interface FetchBudget {
  left: number; // fetches still allowed in this call
  deadline: number; // epoch ms
}

type Page = SyllabusParse | { status: 'failed' | 'skipped' };

/** `skipped` = budget or deadline used up, nothing was requested; `failed` = HTTP error / timeout / network. */
async function fetchDetail(pKey: string, budget: FetchBudget): Promise<Page> {
  const remaining = budget.deadline - nowMs();
  if (budget.left <= 0 || remaining <= 0) return { status: 'skipped' };
  budget.left--;
  try {
    const res = await fetch(`${DETAIL_URL}?pKey=${pKey}&pLng=jp`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' },
      signal: AbortSignal.timeout(remaining),
    });
    return res.ok ? parseSyllabusTerm(await res.text()) : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

export interface LookupCourse {
  id: number;
  idnumber: string;
}

/**
 * `unknown` = the site could not tell (error / timeout): cached for an hour. `skipped` = not asked (budget): try again
 * next call. 総合日本語 sections have no per-class page and stay unknown: the master pages cover both seasons, and
 * nothing on the course (all start 9/21) says which one the section belongs to.
 */
type LookupResult = { kind: 'known'; info: SyllabusInfo | null } | { kind: 'unknown' | 'skipped' };

async function fetchSyllabus(course: LookupCourse, budget: FetchBudget): Promise<LookupResult> {
  const parts = splitIdnumber(course.idnumber);
  if (!parts) return { kind: 'known', info: null };
  const pKey = buildPKey({ ...parts, school: parts.courseKey.slice(0, 2) });
  const page = await fetchDetail(pKey, budget);
  if (page.status === 'ok') {
    const { term, dayPeriod, instructors } = page;
    return { kind: 'known', info: { pKey, year: parts.year, term, dayPeriod, instructors } };
  }
  if (page.status === 'empty') return { kind: 'known', info: null };
  return { kind: page.status === 'skipped' ? 'skipped' : 'unknown' };
}

// ------------------------------------------------------------------ cache + lookup

type Cached = { info: SyllabusInfo | null; fresh: boolean };

function isUnknownMarker(parsed: unknown): boolean {
  return typeof parsed === 'object' && parsed !== null && 'unknown' in parsed;
}

function readCached(idnumber: string, row: { json: string; fetchedAt: number }, at: number): Cached | null {
  try {
    const parsed = JSON.parse(row.json) as SyllabusInfo | { unknown: true } | null;
    const age = at - row.fetchedAt;
    if (isUnknownMarker(parsed)) return { info: null, fresh: age < UNKNOWN_TTL_MS };
    const info = parsed as SyllabusInfo | null;
    const yearOk = info === null || info.year === Number(idnumber.slice(0, 4));
    return { info, fresh: yearOk && age < CACHE_TTL_MS };
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
 * `syllabusLookup: false` (kill switch, and the scheduled sweep) serves cached rows only and fetches nothing.
 * At most 3 fetches and 3 s in total per call.
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

  const budget: FetchBudget = { left: MAX_FETCHES_PER_CALL, deadline: at + LOOKUP_DEADLINE_MS };
  for (const course of eligible.filter((c) => !cache.get(c.idnumber)?.fresh)) {
    const found = await fetchSyllabus(course, budget);
    if (found.kind === 'skipped') break;
    if (found.kind === 'known') result.set(course.id, found.info); // unknown keeps whatever an older row said
    try {
      await ctx.store.putSyllabusCache(
        course.idnumber,
        found.kind === 'known' ? JSON.stringify(found.info) : UNKNOWN_JSON,
        at,
      );
    } catch {
      /* best effort */
    }
  }
  return result;
}
