/**
 * Full public syllabus of one class (概要, 到達目標, 授業計画, 成績評価方法, ...) for `get_syllabus`.
 * Same source as the term lookup (JAA104 detail page, pKey from the course idnumber), parsed by syllabus-page.ts.
 * Public data only, so it is cached globally in syllabus_cache under `d:<idnumber>` (ja) and `d:<idnumber>:en`:
 * 30 days for a page or "no such page", one hour for a failure (a blocked or hanging site is not hit per request).
 * A failed refresh keeps the expired page next to the marker and serves it meanwhile, so an outage never wipes it.
 * The en page is asked for only when the user's Moodle language is English; a missing one falls back to ja.
 */

import type { ServiceContext } from '../context';
import { NotFound } from '../errors';
import { nowMs } from '../time';
import { resolveScope } from './scope';
import { DETAIL_URL, seenIdnumber, syllabusPKey } from './syllabus';
import { parseSyllabusPage, type SyllabusLang, type SyllabusPage } from './syllabus-page';
import { requirePositiveInt } from './validate';

const SEARCH_URL = 'https://www.wsl.waseda.jp/syllabus/index.php';
const USER_AGENT = 'waseda-moodle-mcp/0.1 (+syllabus details)';
const FETCH_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 30 * 86_400_000;
const FAILURE_TTL_MS = 3_600_000;
/** Bump when SyllabusPage changes shape: older cached rows are then fetched again. */
const CACHE_VERSION = 1;
const LANG_PARAM: Record<SyllabusLang, string> = { ja: 'jp', en: 'en' };
/** The site's "no syllabus for this class" page (ja marker is verbatim; the en wording is matched loosely). */
const EMPTY_PAGE_RE = /参照可能なシラバス情報はありません|no syllabus information|no syllabus/i;

/**
 * ok = `page` is set. not-a-class = no per-class page can exist (non-class course / unusual idnumber). no-page = the
 * site has none (e.g. 総合日本語 sections only have a shared master page). unavailable = fetch failed (retried after an
 * hour). disabled = lookup switched off (SYLLABUS_LOOKUP=off) and nothing cached.
 */
export type SyllabusStatus = 'ok' | 'not-a-class' | 'no-page' | 'unavailable' | 'disabled';

export interface SyllabusDetails {
  courseId: number;
  courseName: string;
  status: SyllabusStatus;
  requestedLang: SyllabusLang;
  page: SyllabusPage | null;
  url: string | null; // the public page (its language = page.lang when there is one)
  searchUrl: string; // public syllabus search, for courses without a per-class page
}

interface Target {
  idnumber: string;
  pKey: string;
  lang: SyllabusLang;
}

type Outcome = { kind: 'page'; page: SyllabusPage } | { kind: 'none' | 'failed' | 'off' };
type StoredPage = { v: number; page: SyllabusPage | null };
type Stored = StoredPage | { unknown: true; prev?: StoredPage };
/** What the cache holds: the answer to serve (null = fetch) and the last known page to fall back on. */
type Cached = { outcome: Outcome | null; prev: SyllabusPage | null };

const pageUrl = (pKey: string, lang: SyllabusLang) => `${DETAIL_URL}?pKey=${pKey}&pLng=${LANG_PARAM[lang]}`;
const cacheKey = (t: Target) => (t.lang === 'en' ? `d:${t.idnumber}:en` : `d:${t.idnumber}`);

// ------------------------------------------------------------------ fetch

async function fetchPage(t: Target): Promise<Outcome> {
  try {
    const res = await fetch(pageUrl(t.pKey, t.lang), {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': t.lang },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { kind: 'failed' };
    const html = await res.text();
    const page = parseSyllabusPage(html, t.lang);
    if (page) return { kind: 'page', page };
    return { kind: EMPTY_PAGE_RE.test(html) ? 'none' : 'failed' }; // an unrecognised page is an error, not "none"
  } catch {
    return { kind: 'failed' };
  }
}

// ------------------------------------------------------------------ cache

/** The page of a stored row of the current shape (older shapes are not trusted as a fallback either). */
function pageOf(stored: StoredPage | undefined): SyllabusPage | null {
  return stored?.v === CACHE_VERSION ? stored.page : null;
}

function interpret(stored: Stored, age: number): Cached {
  if ('unknown' in stored) {
    const prev = pageOf(stored.prev);
    if (age >= FAILURE_TTL_MS) return { outcome: null, prev };
    return { outcome: prev ? { kind: 'page', page: prev } : { kind: 'failed' }, prev };
  }
  const page = pageOf(stored);
  if (stored.v !== CACHE_VERSION) return { outcome: null, prev: null };
  if (age >= CACHE_TTL_MS) return { outcome: null, prev: page };
  return { outcome: page ? { kind: 'page', page } : { kind: 'none' }, prev: null };
}

async function readCached(ctx: ServiceContext, key: string, at: number): Promise<Cached> {
  try {
    const row = (await ctx.store.getSyllabusCache([key])).get(key);
    if (!row) return { outcome: null, prev: null };
    return interpret(JSON.parse(row.json) as Stored, at - row.fetchedAt);
  } catch {
    return { outcome: null, prev: null }; // an unreadable cache only costs a fetch
  }
}

function toStored(outcome: Outcome, prev: SyllabusPage | null): Stored {
  if (outcome.kind === 'page') return { v: CACHE_VERSION, page: outcome.page };
  if (outcome.kind === 'none') return { v: CACHE_VERSION, page: null };
  return prev ? { unknown: true, prev: { v: CACHE_VERSION, page: prev } } : { unknown: true };
}

async function persist(ctx: ServiceContext, key: string, stored: Stored, at: number): Promise<void> {
  try {
    await ctx.store.putSyllabusCache(key, JSON.stringify(stored), at);
  } catch {
    /* best effort */
  }
}

// ------------------------------------------------------------------ lookup

async function resolveLang(ctx: ServiceContext, t: Target): Promise<Outcome> {
  const at = nowMs();
  const key = cacheKey(t);
  const { outcome, prev } = await readCached(ctx, key, at);
  if (outcome) return outcome;
  if (ctx.syllabusLookup === false) return { kind: 'off' };
  const fetched = await fetchPage(t);
  await persist(ctx, key, toStored(fetched, prev), at);
  return fetched.kind === 'failed' && prev ? { kind: 'page', page: prev } : fetched;
}

/** The page in the requested language, else (English requested) the Japanese one; otherwise why there is none. */
async function findPage(ctx: ServiceContext, t: Target): Promise<Outcome> {
  const langs: SyllabusLang[] = t.lang === 'en' ? ['en', 'ja'] : ['ja'];
  let outcome: Outcome = { kind: 'none' };
  for (const lang of langs) {
    outcome = await resolveLang(ctx, { ...t, lang });
    if (outcome.kind === 'page') break;
  }
  return outcome;
}

const FAILURE_STATUS = { none: 'no-page', failed: 'unavailable', off: 'disabled' } as const;

export async function getSyllabusDetails(ctx: ServiceContext, courseId: number): Promise<SyllabusDetails> {
  const id = requirePositiveInt(courseId, 'course_id');
  const course = (await resolveScope(ctx)).courses.find((c) => c.id === id);
  if (!course) throw new NotFound(`Course ${id} is not one of your enrolled courses (see list_courses).`);
  const lang: SyllabusLang = /^en/i.test(ctx.user.lang) ? 'en' : 'ja';
  const base = { courseId: id, courseName: course.name, requestedLang: lang, searchUrl: SEARCH_URL };
  const idnumber = seenIdnumber(ctx, id);
  const pKey = idnumber ? syllabusPKey(idnumber) : null;
  if (!idnumber || !pKey) return { ...base, status: 'not-a-class', page: null, url: null };
  const found = await findPage(ctx, { idnumber, pKey, lang });
  if (found.kind === 'page') {
    return { ...base, status: 'ok', page: found.page, url: pageUrl(pKey, found.page.lang) };
  }
  const url = found.kind === 'none' ? null : pageUrl(pKey, lang); // a failed page may still be opened by hand
  return { ...base, status: FAILURE_STATUS[found.kind], page: null, url };
}

/** found = a cached page; not-found = cached "no page" (or no page can exist); unknown = nothing usable cached. */
export type CachedSyllabusStatus = 'found' | 'not-found' | 'unknown';

interface CachedSyllabusPage {
  url: string | null;
  page: SyllabusPage | null;
  status: CachedSyllabusStatus;
}

type CacheRow = { json: string; fetchedAt: number } | undefined;

/** What one cached row says: a page (or the previous page of a failed refresh), a fresh "none", or nothing. */
function cachedOutcome(row: CacheRow, at: number): { page: SyllabusPage } | 'none' | null {
  if (!row) return null;
  try {
    const { outcome, prev } = interpret(JSON.parse(row.json) as Stored, at - row.fetchedAt);
    if (outcome?.kind === 'page') return { page: outcome.page };
    if (prev) return { page: prev };
    return outcome?.kind === 'none' ? 'none' : null;
  } catch {
    return null;
  }
}

/** The requested language first, then (English requested) Japanese — like findPage, but from the cache only. */
function cachedForTarget(
  t: Target,
  rows: ReadonlyMap<string, { json: string; fetchedAt: number }>,
  at: number,
): { page: SyllabusPage | null; status: CachedSyllabusStatus } {
  const langs: SyllabusLang[] = t.lang === 'en' ? ['en', 'ja'] : ['ja'];
  let allNone = true;
  for (const lang of langs) {
    const got = cachedOutcome(rows.get(cacheKey({ ...t, lang })), at);
    if (got !== null && got !== 'none') return { page: got.page, status: 'found' };
    if (got === null) allNone = false;
  }
  return { page: null, status: allNone ? 'not-found' : 'unknown' };
}

function cacheKeysFor(t: Target): string[] {
  const ja = cacheKey({ ...t, lang: 'ja' });
  return t.lang === 'en' ? [cacheKey(t), ja] : [ja];
}

/** Details pages already in D1; never fetches. Every requested id is present (`page: null` and a status on miss). */
export async function readCachedSyllabusPages(
  ctx: ServiceContext,
  courseIds: readonly number[],
): Promise<Map<number, CachedSyllabusPage>> {
  const lang: SyllabusLang = /^en/i.test(ctx.user.lang) ? 'en' : 'ja';
  const wanted: Array<{ id: number; t: Target }> = [];
  for (const id of courseIds) {
    const idnumber = seenIdnumber(ctx, id);
    const pKey = idnumber ? syllabusPKey(idnumber) : null;
    if (idnumber && pKey) wanted.push({ id, t: { idnumber, pKey, lang } });
  }
  let rows = new Map<string, { json: string; fetchedAt: number }>();
  try {
    rows = await ctx.store.getSyllabusCache(wanted.flatMap(({ t }) => cacheKeysFor(t)));
  } catch {
    /* unreadable cache is a miss */
  }
  const at = nowMs();
  const out = new Map<number, CachedSyllabusPage>();
  // no idnumber / pKey: no per-class page can exist (getSyllabusDetails says not-a-class)
  for (const id of courseIds) out.set(id, { url: null, page: null, status: 'not-found' });
  for (const { id, t } of wanted) {
    const { page, status } = cachedForTarget(t, rows, at);
    out.set(id, { url: page ? pageUrl(t.pKey, page.lang) : null, page, status });
  }
  return out;
}
