/**
 * Term lookup from the public Waseda syllabus (www.wsl.waseda.jp): idnumber -> pKey -> detail page -> 学期曜日時限.
 * Moodle cannot tell 秋クォーター from 冬クォーター (all class courses span 9/21-3/31), the syllabus can. The same page
 * carries the weekly meeting slots (day, periods, room, campus) the timetable is built from (syllabus-schedule.ts).
 * Policy: on-demand only (enrolled class courses), <= 12 fetches (3 at a time) and one 5 s deadline per call, so a new
 * user's courses are known on the first call; results (also "none") cached globally for the academic year, failures cached as "unknown" for an hour (the previous answer, if
 * any, is kept next to the marker and keeps being served). robots.txt disallows crawlers, so there is no
 * search-form scraping.
 */

import type { ServiceContext } from '../context';
import { decodeEntities } from '../html';
import { isoJst, nowMs } from '../time';
import { parseSchedule, type Schedule, type SyllabusSlot } from './syllabus-schedule';

export type { SyllabusSlot };

const DETAIL_URL = 'https://www.wsl.waseda.jp/syllabus/JAA104.php';
const USER_AGENT = 'waseda-moodle-mcp/0.1 (+syllabus term lookup)';
/** One deadline for every fetch of a lookup call, so a hanging site costs a request at most this much. */
const LOOKUP_DEADLINE_MS = 5000;
/** A page takes ~0.6 s and ~0.05 ms CPU to parse; 12 cover a typical term, well inside the 50 subrequests of a call. */
export const MAX_FETCHES_PER_CALL = 12;
export const FETCH_CONCURRENCY = 3;
const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 365 * DAY_MS;
/** Server errors, timeouts and システムエラー pages: remembered as "unknown" so a blocked / hanging site is not retried per request. */
const UNKNOWN_TTL_MS = 3_600_000;
const UNKNOWN_JSON = '{"unknown":true}';
/** A term counts as current this long before it starts (pre-course material and deadlines appear earlier)... */
const TERM_LOOKAHEAD_MS = 14 * DAY_MS;
/** ...and this long after it ends (final reports are due and swept after the last class). */
const TERM_GRACE_MS = 14 * DAY_MS;
const EMPTY_MARKER = '参照可能なシラバス情報はありません';
/** `春学期／秋学期` (a course given in both) is stored as one string; every term matcher splits on this. */
const TERM_JOIN = '／';
const TERM_NAME = '春学期|秋学期|春クォーター|夏クォーター|秋クォーター|冬クォーター|通年|集中';
/** `集中講義（秋学期）` counts as 集中: whether it is an autumn block does not change that it has no weekly slot. */
const TERM_ITEM = `(?:${TERM_NAME})(?:講義(?:[（(][^）)]*[）)])?)?`;
const TERM_LIST_RE = new RegExp(`^${TERM_ITEM}(?:${TERM_JOIN}${TERM_ITEM})*`);
const TERM_NAME_RE = new RegExp(`^(?:${TERM_NAME})`);

export interface SyllabusInfo {
  pKey: string;
  year: number; // academic year of the idnumber the lookup was made for
  term: string | null; // 春クォーター, 秋学期, 通年, ... or `春学期／秋学期` for several; null when none is recognised
  dayPeriod: string | null; // e.g. "月１-２"
  instructors: string[];
  /**
   * Meeting slots, the on-demand flag and whether some part of the cell was not understood. Rows cached before the
   * schedule parser existed (schema v1, no `slots`) are re-parsed from `dayPeriod` on read; rows without
   * `scheduleUnparsed` (v2) are served as they are. Both are fetched again lazily, current academic year first.
   */
  slots?: SyllabusSlot[];
  onDemand?: boolean;
  scheduleUnparsed?: boolean;
}

export type SyllabusParse =
  | ({ status: 'ok'; term: string | null; dayPeriod: string | null; instructors: string[] } & Schedule)
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

const termNames = (listText: string) => listText.split(TERM_JOIN).flatMap((item) => TERM_NAME_RE.exec(item)?.[0] ?? []);

function splitTermCell(text: string): { term: string | null; dayPeriod: string | null } {
  const m = TERM_LIST_RE.exec(text);
  const rest = m ? text.slice(m[0].length).trim() : text;
  return { term: m ? termNames(m[0]).join(TERM_JOIN) : null, dayPeriod: rest || null };
}

/** `学期曜日時限` (ja) -> term + day/period + meeting slots (with `使用教室` / `キャンパス`); `担当教員` -> instructors. */
export function parseSyllabusTerm(html: string): SyllabusParse {
  const cell = cellText(html, '学期曜日時限');
  if (cell === null) return { status: html.includes(EMPTY_MARKER) ? 'empty' : 'error' };
  const instructors = (cellText(html, '担当教員') ?? '')
    .split(/[、／,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const termCell = splitTermCell(cell);
  const schedule = parseSchedule({
    dayPeriod: termCell.dayPeriod,
    classroom: cellText(html, '使用教室'),
    campus: cellText(html, 'キャンパス'),
  });
  return { status: 'ok', ...termCell, instructors, ...schedule };
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

/** Whether any of the terms of `term` (one name or a `／`-joined list) is in session. */
export function inCurrentTerm(term: string | null, at: number): boolean {
  const current = currentTerms(at);
  return term?.split(TERM_JOIN).some((t) => current.has(t)) === true;
}

/** Academic year containing `at` (JST): January-March still belong to the year that began the previous April. */
export function academicYear(at: number): number {
  const iso = isoJst(at);
  return Number(iso.slice(0, 4)) - (Number(iso.slice(5, 7)) <= 3 ? 1 : 0);
}

/**
 * 'unknown' for no term and for 集中 (intensive blocks): the lastaccess / calendar signals decide those.
 * `year` = the course's academic year (idnumber); a term only fits when that is the current one (null = not known).
 * A term is current from 14 days before it starts until 14 days after it ends.
 */
export function termFit(
  term: string | null,
  at: number,
  year: number | null = null,
): 'current' | 'not-current' | 'unknown' {
  if (term === null || term === '集中') return 'unknown';
  const fits = (t: number) => inCurrentTerm(term, t) && (year === null || year === academicYear(t));
  return [0, TERM_LOOKAHEAD_MS, -TERM_GRACE_MS].some((shift) => fits(at + shift)) ? 'current' : 'not-current';
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
    const { term, dayPeriod, instructors, slots, onDemand, scheduleUnparsed } = page;
    const info = { pKey, year: parts.year, term, dayPeriod, instructors, slots, onDemand, scheduleUnparsed };
    return { kind: 'known', info };
  }
  if (page.status === 'empty') return { kind: 'known', info: null };
  return { kind: page.status === 'skipped' ? 'skipped' : 'unknown' };
}

// ------------------------------------------------------------------ cache + lookup

/** `known` false = a failure marker with no earlier answer: the site could not tell yet (backing off while fresh). */
type Cached = { info: SyllabusInfo | null; fresh: boolean; known: boolean };

/** What the cache table holds: a result (`null` = no syllabus), or a failure marker with the answer it replaced. */
type UnknownMarker = { unknown: true; prev?: SyllabusInfo };

function isUnknownMarker(parsed: unknown): parsed is UnknownMarker {
  return typeof parsed === 'object' && parsed !== null && 'unknown' in parsed;
}

/**
 * The stored info as served, and whether it is up to date. v1 rows have no slots: they are re-parsed from `dayPeriod`.
 * v1 / v2 rows (no `scheduleUnparsed`) are refetched only for the current academic year: for other years the term is
 * all anyone needs, and refetching them would use up the call's fetches before the user's own courses get theirs.
 */
function revive(stored: SyllabusInfo | null, idnumber: string, at: number): Omit<Cached, 'known'> {
  if (stored === null) return { info: null, fresh: true };
  const info = stored.slots === undefined ? { ...stored, ...parseSchedule({ dayPeriod: stored.dayPeriod }) } : stored;
  const yearOk = info.year === Number(idnumber.slice(0, 4));
  const outdated = stored.scheduleUnparsed === undefined && info.year === academicYear(at);
  return { info, fresh: yearOk && !outdated };
}

function readCached(idnumber: string, row: { json: string; fetchedAt: number }, at: number): Cached | null {
  try {
    const parsed = JSON.parse(row.json) as SyllabusInfo | UnknownMarker | null;
    const age = at - row.fetchedAt;
    if (isUnknownMarker(parsed)) {
      const prev = parsed.prev ?? null;
      return { info: revive(prev, idnumber, at).info, fresh: age < UNKNOWN_TTL_MS, known: prev !== null };
    }
    const { info, fresh } = revive(parsed, idnumber, at);
    return { info, fresh: fresh && age < CACHE_TTL_MS, known: true };
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

/** What one request (= one ServiceContext) has already asked, so a second service call can build on it. */
interface RequestState {
  seen: Map<number, LookupCourse>;
  spent: number; // fetches made so far in this request
  enabled: boolean; // whether the last lookup was allowed to fetch
}

const requests = new WeakMap<ServiceContext, RequestState>();

function requestState(ctx: ServiceContext): RequestState {
  let state = requests.get(ctx);
  if (!state) {
    state = { seen: new Map(), spent: 0, enabled: true };
    requests.set(ctx, state);
  }
  return state;
}

/** A failed fetch keeps the previous answer next to the marker: the hour of back-off must not wipe a usable row. */
function rowJson(found: LookupResult, prev: SyllabusInfo | null): string {
  if (found.kind === 'known') return JSON.stringify(found.info);
  return prev ? JSON.stringify({ unknown: true, prev }) : UNKNOWN_JSON;
}

async function persist(ctx: ServiceContext, idnumber: string, json: string, at: number): Promise<void> {
  try {
    await ctx.store.putSyllabusCache(idnumber, json, at);
  } catch {
    /* best effort */
  }
}

/**
 * Courses to fetch, in the order that serves the user best: the confirmed selection first, then courses of the current
 * academic year, then the rest (Moodle order within each group).
 */
function fetchOrder(ctx: ServiceContext, courses: LookupCourse[], at: number): LookupCourse[] {
  const mine = new Set(ctx.user.settings.myCourseIds ?? []);
  const year = academicYear(at);
  const rank = (c: LookupCourse): number => {
    if (mine.has(c.id)) return 0;
    return splitIdnumber(c.idnumber)?.year === year ? 1 : 2;
  };
  return [...courses].sort((a, b) => rank(a) - rank(b));
}

/**
 * Syllabus info per course id (`null` = unknown). Never throws: the scope must not depend on a third-party site.
 * `syllabusLookup: false` (kill switch, and the scheduled sweep) serves cached rows only and fetches nothing.
 * At most 12 fetches (3 at a time) and 5 s in total per call; `sharedBudget` makes them cover the whole request.
 */
export async function lookupTerms(
  ctx: ServiceContext,
  courses: LookupCourse[],
  opts: { syllabusLookup?: boolean; sharedBudget?: boolean } = {},
): Promise<Map<number, SyllabusInfo | null>> {
  const at = nowMs();
  const state = requestState(ctx);
  for (const c of courses) state.seen.set(c.id, c);
  state.enabled = opts.syllabusLookup !== false;
  const eligible = courses.filter((c) => splitIdnumber(c.idnumber));
  const cache = await readCache(
    ctx,
    eligible.map((c) => c.idnumber),
    at,
  );
  // no key = not known yet (no cached row and not fetched in this call); null = known to have no usable syllabus
  const result = new Map<number, SyllabusInfo | null>();
  for (const c of courses) {
    const cached = cache.get(c.idnumber);
    if (cached?.known) result.set(c.id, cached.info);
    else if (!splitIdnumber(c.idnumber)) result.set(c.id, null);
  }
  if (!state.enabled) return result;

  const allowed = opts.sharedBudget ? Math.max(0, MAX_FETCHES_PER_CALL - state.spent) : MAX_FETCHES_PER_CALL;
  const budget: FetchBudget = { left: allowed, deadline: at + LOOKUP_DEADLINE_MS };
  const stale = eligible.filter((c) => !cache.get(c.idnumber)?.fresh);
  const queue = fetchOrder(ctx, stale, at);
  const worker = async () => {
    for (let course = queue.shift(); course; course = queue.shift()) {
      const found = await fetchSyllabus(course, budget);
      if (found.kind === 'skipped') return;
      if (found.kind === 'known') result.set(course.id, found.info); // unknown keeps whatever an older row said
      await persist(ctx, course.idnumber, rowJson(found, cache.get(course.idnumber)?.info ?? null), at);
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker)); // highest-priority courses go first
  state.spent += allowed - budget.left;
  return result;
}

/**
 * Info for courses an earlier lookupTerms call of this request (the course scope) already presented, within what is
 * left of the request's fetches. Ids never presented, or not fetched yet, have no key. This is how the timetable reuses the scope's
 * lookup without a second Moodle call for idnumbers.
 */
export function lookupSeenCourses(ctx: ServiceContext, ids: number[]): Promise<Map<number, SyllabusInfo | null>> {
  const state = requestState(ctx);
  const courses = ids.flatMap((id) => state.seen.get(id) ?? []);
  return lookupTerms(ctx, courses, { syllabusLookup: state.enabled, sharedBudget: true });
}
