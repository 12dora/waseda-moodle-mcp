/** Drops sweep items that a calendar item already covers. */

import { deadlineMs, isoJst } from '../../time';
import type { DueItem } from '../../types';

const STOP = new Set(['due', 'the', 'and', 'for', 'deadline', 'noon', 'session']);
const CJK_PAIR = /^[\p{Script=Han}\p{Script=Katakana}ー]{2}$/u;
const WORDS = /[^\p{L}\p{N}ー]+/u;

/** Comparable words of a name: lower-case NFKC words, plus Han/Katakana bigrams (Japanese has no spaces). */
export function nameTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.normalize('NFKC').toLowerCase().split(WORDS)) {
    if (w.length < 2 || /^\d+$/.test(w) || STOP.has(w)) continue;
    out.add(w);
    for (let i = 0; i + 2 <= w.length; i++) if (CJK_PAIR.test(w.slice(i, i + 2))) out.add(w.slice(i, i + 2));
  }
  return out;
}

/** Calendar date (JST) the deadline reads as; exactly 00:00 counts as the previous day. */
const dayOf = (item: DueItem): string | null => (item.dueAt ? isoJst(deadlineMs(item.dueAt)).slice(0, 10) : null);

function sharesToken(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

interface Covering {
  courseId: number;
  day: string;
  cmid: number | null;
  tokens: Set<string>;
}

function coverings(items: readonly DueItem[]): Covering[] {
  const out: Covering[] = [];
  for (const it of items) {
    const day = dayOf(it) ?? (it.opensAt ? isoJst(Date.parse(it.opensAt)).slice(0, 10) : null);
    if (day) out.push({ courseId: it.courseId, day, cmid: it.cmid, tokens: nameTokens(it.name) });
  }
  return out;
}

function isCovered(text: DueItem, cover: readonly Covering[], calendarCmids: ReadonlySet<number>): boolean {
  if (text.cmid !== null && calendarCmids.has(text.cmid)) return true; // the calendar owns that activity's date
  const day = dayOf(text);
  if (!day) return false;
  const tokens = nameTokens(`${text.name} ${text.evidence ?? ''}`);
  return cover.some((c) => c.courseId === text.courseId && c.day === day && sharesToken(c.tokens, tokens));
}

/** Text items the calendar does not already cover (same course, same day, shared name word; or same cmid). */
export function dropCoveredText(textItems: readonly DueItem[], calendar: readonly DueItem[]): DueItem[] {
  const cover = coverings(calendar);
  const calendarCmids = new Set(calendar.flatMap((c) => (c.cmid === null ? [] : [c.cmid])));
  return textItems.filter((t) => !isCovered(t, cover, calendarCmids));
}
