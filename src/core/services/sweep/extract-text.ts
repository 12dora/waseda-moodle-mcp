/**
 * Deadline mentions in free text: "10月15日（木）23：59までに…", "Report Due on 10/18", "Due 11 PM, 10/12 (Mon)".
 * Pure and single-pass: a handful of linear regex scans, no nested quantifiers. Input is NFKC-normalised first
 * (full-width digits / colons / parentheses become ASCII).
 */

import { jstParts } from '../../time';

export const EVIDENCE_MAX = 160;
const SNIPPET_PAD = 60;
const CUE_PAD = 80;
const TIME_PAD = 40;
const LEAD_MAX = 30;
const MAX_HITS_PER_PATTERN = 300;
const DEFAULT_MAX = 12;
const CANDIDATES_MAX = 40; // upcoming candidates examined per text before the nearest `max` are picked
const EXAMINED_MAX = 80; // dates inside the window that get the (costlier) context / time checks, kept or not
const DAY = 86_400_000;
const JST_MS = 9 * 3_600_000;
const PAST_LIMIT = 30 * DAY;
const FUTURE_LIMIT = 180 * DAY;
const DAY_SPAN = DAY + 3_600_000; // a date covers its whole day (24:59 at most)
const DEFAULT_TIME = { h: 23, mi: 59 };

export interface TextDeadline {
  ms: number; // the deadline instant
  evidence: string; // snippet around the date, <= EVIDENCE_MAX chars
  lead: string; // <= LEAD_MAX chars written right before the date, cut at the sentence start ('' when none)
}

// ------------------------------------------------------------------ dates

interface DateParts {
  y: number | null;
  mo: number;
  d: number;
}

interface DateHit extends DateParts {
  start: number;
  end: number;
}

interface DatePattern {
  re: RegExp;
  pick: (m: RegExpExecArray) => DateParts;
}

const MONTH_NAME =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const YEAR_TAIL = '(?:,?\\s+(20\\d\\d)(?!\\d))?';
/** A label word right before a number: "課題1", "Q2", "Quiz 2", "Assignment 1", "HW3", "No.4", "#5", "第6". */
const LABEL =
  '(?:課題|レポート|宿題|小テスト|テスト|演習|問題|第|#|' +
  '(?<![a-z])(?:q|quiz|report|no\\.?|assign(?:ment)?|hw|homework|task|week|lesson|session|unit|part|ex(?:ercise)?))\\s?';
/** "12:10/13" starts inside a clock time, but "課題1:10/21" is a label, a colon and a date. */
const NOT_CLOCK = `(?<!(?<!${LABEL}\\d?)\\d:)`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const monthNumber = (name: string | undefined) => MONTHS.indexOf((name ?? '').slice(0, 3).toLowerCase()) + 1;
const yearOf = (s: string | undefined) => (s ? Number(s) : null);

const DATE_PATTERNS: DatePattern[] = [
  {
    re: /(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日/g,
    pick: (m) => ({ y: yearOf(m[1]), mo: Number(m[2]), d: Number(m[3]) }),
  },
  {
    re: new RegExp(`(?<![\\d/.-])${NOT_CLOCK}(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})(?!\\d)`, 'gi'),
    pick: (m) => ({ y: yearOf(m[1]), mo: Number(m[2]), d: Number(m[3]) }),
  },
  {
    re: new RegExp(`(?<![\\d/.-])${NOT_CLOCK}(\\d{1,2})/(\\d{1,2})(?![\\d/:])`, 'gi'),
    pick: (m) => ({ y: null, mo: Number(m[1]), d: Number(m[2]) }),
  },
  {
    re: new RegExp(`(?<![a-z])(${MONTH_NAME})\\.?[ \\t]*(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])${YEAR_TAIL}`, 'gi'),
    pick: (m) => ({ y: yearOf(m[3]), mo: monthNumber(m[1]), d: Number(m[2]) }),
  },
  {
    re: new RegExp(
      `(?<![\\d/.-])${NOT_CLOCK}(\\d{1,2})(?:st|nd|rd|th)?[ \\t]+(?:of[ \\t]+)?(${MONTH_NAME})(?![a-z])${YEAR_TAIL}`,
      'gi',
    ),
    pick: (m) => ({ y: yearOf(m[3]), mo: monthNumber(m[2]), d: Number(m[1]) }),
  },
];

function findDateHits(text: string): DateHit[] {
  const hits: DateHit[] = [];
  for (const p of DATE_PATTERNS) {
    let n = 0;
    for (const m of text.matchAll(p.re)) {
      const start = m.index ?? 0;
      hits.push({ ...p.pick(m), start, end: start + m[0].length });
      if (++n >= MAX_HITS_PER_PATTERN) break;
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: DateHit[] = [];
  let last = 0;
  for (const h of hits) {
    if (h.start < last) continue; // overlaps an earlier, longer hit
    out.push(h);
    last = h.end;
  }
  return out;
}

// ------------------------------------------------------------------ times

interface TimeHit {
  start: number;
  end: number;
  h: number;
  mi: number;
}

type HM = [h: number, mi: number];

function to24(h: number, mi: number, meridiem: string | undefined): HM | null {
  if (mi > 59) return null;
  if (!meridiem || h > 12 || h === 0) return h <= 24 ? [h, mi] : null; // "23:00 p.m." is just 23:00
  const pm = meridiem.toLowerCase().startsWith('p') || meridiem === '午後';
  return [(h % 12) + (pm ? 12 : 0), mi];
}

const TIME_PATTERNS: Array<{ re: RegExp; pick: (m: RegExpExecArray) => HM | null }> = [
  {
    re: /(?<![\d:.])(\d{1,2}):(\d{2})(?![\d:])(?:\s*([ap])\.?m\b)?/gi,
    pick: (m) => to24(Number(m[1]), Number(m[2]), m[3]),
  },
  { re: /(?<![\d:.])(\d{1,2})\s*([ap])\.?m\b/gi, pick: (m) => to24(Number(m[1]), 0, m[2]) },
  { re: /\bnoon\b|正午/gi, pick: () => [12, 0] },
  {
    re: /(午前|午後)?\s*(\d{1,2})\s*時(?![間限])(?:\s*(\d{1,2})\s*分|(半))?/g,
    pick: (m) => to24(Number(m[2]), m[4] ? 30 : Number(m[3] ?? 0), m[1]),
  },
];

function scanTimes(text: string, from: number, to: number): TimeHit[] {
  const slice = text.slice(Math.max(0, from), to);
  const out: TimeHit[] = [];
  for (const p of TIME_PATTERNS) {
    for (const m of slice.matchAll(p.re)) {
      const hm = p.pick(m);
      if (!hm) continue;
      const start = Math.max(0, from) + (m.index ?? 0);
      out.push({ start, end: start + m[0].length, h: hm[0], mi: hm[1] });
    }
  }
  return out;
}

/** The time token closest to the date, searched between the neighbouring dates (never across them). */
function nearestTime(text: string, hit: DateHit, bounds: { lo: number; hi: number }): { h: number; mi: number } {
  const lo = Math.max(bounds.lo, hit.start - TIME_PAD);
  const hi = Math.min(bounds.hi, hit.end + TIME_PAD);
  let best: TimeHit | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of [...scanTimes(text, lo, hit.start), ...scanTimes(text, hit.end, hi)]) {
    const dist = t.end <= hit.start ? hit.start - t.end : t.start - hit.end;
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best ?? DEFAULT_TIME;
}

// ------------------------------------------------------------------ year inference

function validDay(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const toMs = (y: number, p: { mo: number; d: number }, t: { h: number; mi: number }) =>
  Date.UTC(y, p.mo - 1, p.d, t.h, t.mi) - JST_MS;

/**
 * Year inference: an explicit year wins; otherwise the candidate year whose date lies within [-30 d, +180 d]
 * of `now` and closest to it. null when no candidate fits (or the date does not exist).
 */
export function inferDeadlineMs(date: DateParts, time: { h: number; mi: number }, now: number): number | null {
  if (date.y !== null) return validDay(date.y, date.mo, date.d) ? toMs(date.y, date, time) : null;
  const thisYear = jstParts(now).y;
  let best: number | null = null;
  for (const y of [thisYear - 1, thisYear, thisYear + 1]) {
    if (!validDay(y, date.mo, date.d)) continue;
    const ms = toMs(y, date, time);
    const delta = ms - now;
    if (delta < -PAST_LIMIT || delta > FUTURE_LIMIT) continue;
    if (best === null || Math.abs(delta) < Math.abs(best - now)) best = ms;
  }
  return best;
}

// ------------------------------------------------------------------ context checks

/** A deadline-ish word near the date; bare "10/12" in a schedule table is not a deadline. */
const CUE =
  /due\b|deadline|submi|\bby\b|until|before|\bclos|\bend|report|assign|quiz|exam|\btest\b|提出|締切|締め切り|期限|期日|まで|〆|レポート|課題|試験|テスト|回答|宿題|アンケート/i;
/** "from Oct 15", "opens 10/15", "10月15日から": an opening date, not a deadline. */
const OPENS_BEFORE = /(?:\bfrom|\bsince|\bopens?|\bstarts?|開始|公開)\s*(?:on\s+|:)?$/i;
/** "10/12 - 10/18", "10月15日〜", "10月15日から": the date starts a range. */
const RANGE_AFTER = /^\s*(?:\([^)]{1,4}\))?\s*(?:\d{1,2}:\d{2})?\s*(?:[~〜]|から|より|[–—-]\s*\d)/;

function isDeadlineContext(text: string, hit: DateHit): boolean {
  if (!CUE.test(text.slice(Math.max(0, hit.start - CUE_PAD), hit.end + CUE_PAD))) return false;
  if (OPENS_BEFORE.test(text.slice(Math.max(0, hit.start - 14), hit.start))) return false;
  return !RANGE_AFTER.test(text.slice(hit.end, hit.end + 16));
}

function snippet(text: string, hit: DateHit): string {
  const from = Math.max(0, hit.start - SNIPPET_PAD);
  const to = Math.min(text.length, hit.end + SNIPPET_PAD);
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim();
  const out = `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
  return out.length <= EVIDENCE_MAX ? out : `${out.slice(0, EVIDENCE_MAX - 1)}…`;
}

const LEAD_TAIL = /[\s*_([（［「『:：,、\-–~〜]+$/;
const TRAILING_CUE = /(?:^|\s+)(?:(?:by|on|before|until|due|deadline|closes?|ends?|at|is)\s*)+$/i;

/** The words just before the date ("課題の提出" in "課題の提出 10月20日まで"), as a short trigger phrase for a title. */
function leadPhrase(text: string, hit: DateHit): string {
  const from = Math.max(0, hit.start - LEAD_MAX);
  const pieces = text.slice(from, hit.start).split(/[\n\r。！？!?;；|]/);
  let lead = pieces.at(-1) ?? '';
  if (pieces.length === 1 && from > 0 && /\w/.test(text.charAt(from - 1))) lead = lead.replace(/^\w+/, ''); // cut mid-word
  return lead
    .replace(/^[\s*_#>\-•・:：,、.]+/, '')
    .replace(LEAD_TAIL, '')
    .replace(TRAILING_CUE, '')
    .replace(LEAD_TAIL, '')
    .trim();
}

// ------------------------------------------------------------------ public

/** Cheap pre-check for callers that store text: dates need digits (full-width digits included). */
const mayHaveDate = (text: string): boolean => /[\d０-９]/.test(text);

/** The `max` candidates closest to `now`, back in order of appearance. */
function nearestTo(found: TextDeadline[], max: number, now: number): TextDeadline[] {
  if (found.length <= max) return found;
  const keep = new Set([...found].sort((a, b) => Math.abs(a.ms - now) - Math.abs(b.ms - now)).slice(0, max));
  return found.filter((d) => keep.has(d));
}

interface DeadlineWindow {
  now: number;
  from: number;
  year: number; // JST year of `now`
}

/**
 * How far (ms) the date's day lies from `now`, judged on the date alone; null when it cannot be a deadline in the window
 * (before `from`, outside the year-inference window, or an explicit-year date beyond it so far-future dates cost nothing).
 */
function dayDistance(date: DateParts, win: DeadlineWindow): number | null {
  const years = date.y === null ? [win.year - 1, win.year, win.year + 1] : [date.y];
  let best: number | null = null;
  for (const y of years) {
    if (!validDay(y, date.mo, date.d)) continue;
    const start = toMs(y, date, { h: 0, mi: 0 });
    const end = start + DAY_SPAN;
    const tooOld = date.y === null && end < win.now - PAST_LIMIT; // an explicit year is never too old, only `from` cuts
    if (end < win.from || tooOld || start > win.now + FUTURE_LIMIT) continue;
    const dist = Math.max(0, start - win.now, win.now - end);
    if (best === null || dist < best) best = dist;
  }
  return best;
}

/** The deadline of `hit` (its time is searched within `bounds`), or null when it is none or lies outside the window. */
function deadlineAt(
  text: string,
  hit: DateHit,
  bounds: { lo: number; hi: number },
  win: DeadlineWindow,
): TextDeadline | null {
  if (!isDeadlineContext(text, hit)) return null;
  const ms = inferDeadlineMs(hit, nearestTime(text, hit, bounds), win.now);
  if (ms === null || ms < win.from) return null;
  return { ms, evidence: snippet(text, hit), lead: leadPhrase(text, hit) };
}

/** Indexes of the EXAMINED_MAX hits whose day is nearest to now (in-window only), nearest first. */
function nearestHits(hits: DateHit[], win: DeadlineWindow): number[] {
  const near = hits.flatMap((hit, i) => {
    const dist = dayDistance(hit, win);
    return dist === null ? [] : [{ i, dist }];
  });
  near.sort((a, b) => a.dist - b.dist || a.i - b.i);
  return near.slice(0, EXAMINED_MAX).map((h) => h.i);
}

/**
 * Deadlines mentioned in `text`, in order of appearance; each with its snippet. `now` is unix ms.
 * Dates before `opts.from` (or outside the year-inference window) are skipped on the date alone, before anything is
 * counted, so past dates never take a slot nor cost a context check; only the EXAMINED_MAX dates nearest to `now`
 * are looked at. When more than `opts.max` deadlines remain, the ones closest to `now` are kept.
 */
export function findDeadlines(raw: string, now: number, opts: { max?: number; from?: number } = {}): TextDeadline[] {
  if (!mayHaveDate(raw)) return [];
  const text = raw.normalize('NFKC');
  const win = { now, from: opts.from ?? Number.NEGATIVE_INFINITY, year: jstParts(now).y };
  const hits = findDateHits(text);
  const out: Array<TextDeadline & { at: number }> = [];
  const seen = new Set<number>();
  for (const i of nearestHits(hits, win)) {
    if (out.length >= CANDIDATES_MAX) break;
    const hit = hits[i];
    if (!hit) continue;
    const bounds = { lo: hits[i - 1]?.end ?? 0, hi: hits[i + 1]?.start ?? text.length };
    const found = deadlineAt(text, hit, bounds, win);
    if (!found || seen.has(found.ms)) continue;
    seen.add(found.ms);
    out.push({ ...found, at: i });
  }
  out.sort((a, b) => a.at - b.at); // back to order of appearance
  return nearestTo(
    out.map(({ at: _, ...d }) => d),
    opts.max ?? DEFAULT_MAX,
    now,
  );
}
