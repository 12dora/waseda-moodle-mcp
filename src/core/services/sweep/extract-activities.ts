/** Sweep extractors over one snapshot: pending activities without a deadline, and deadlines written in text. */

import type { DueItem } from '../../types';
import { buildSweepItem, kindOf } from './due-item';
import { findDeadlines, type TextDeadline } from './extract-text';
import { hasOwnDeadline, isOwnDeadlineText } from './own-deadline';
import { type CourseSnapshot, MENTIONS_PER_TEXT, type SnapModule, type SnapText } from './snapshot';
import type { CourseRef } from './types';

const PENDING_MODS = new Set(['assign', 'quiz', 'questionnaire', 'workshop', 'lesson', 'feedback', 'h5pactivity']);
/** Quizzes / H5P named like self-study material are noise unless the course tracks them as incomplete. */
const PRACTICE_MODS = new Set(['quiz', 'h5pactivity']);
const PRACTICE_NAME = /れんしゅう|練習|practice|sample|模擬/i;
const MAX_TEXT_ITEMS = 30;
const PAST_MENTION_MS = 86_400_000; // text mentions older than this are dropped

/** The period text mentions are reported for; `now` anchors the grace for just-passed dates and the cap order. */
export interface TextWindow {
  now: number;
  fromMs: number;
  toMs: number;
}

/** Whether a text mention is inside the window; one past by over a day is noise (we cannot know if it was done). */
export function inTextWindow(at: number, w: TextWindow): boolean {
  return at >= Math.max(w.fromMs, w.now - PAST_MENTION_MS) && at <= w.toMs;
}

const ms = (sec: number | undefined) => (sec ? sec * 1000 : null);

const isPractice = (m: SnapModule) => PRACTICE_MODS.has(m.t) && PRACTICE_NAME.test(m.n.normalize('NFKC'));

/** Task modules of a snapshot by cmid (assign, quiz, questionnaire...). */
export function taskModules(snap: CourseSnapshot): Map<number, SnapModule> {
  const out = new Map<number, SnapModule>();
  for (const sec of snap.s) for (const m of sec.m) if (PENDING_MODS.has(m.t)) out.set(m.c, m);
  return out;
}

/** Dated activities belong to the calendar; the sweep only reports the ones Moodle gives no deadline. */
function isUndatedPending(m: SnapModule): boolean {
  if (!PENDING_MODS.has(m.t) || m.v === 0 || m.k === 1) return false;
  if (isPractice(m) && m.k !== 0) return false; // practice material without "incomplete" tracking
  return !hasOwnDeadline(m);
}

/** (a) pending activities without a calendar deadline. Hidden / completed ones and ones opening after `toMs` are skipped. */
export function pendingActivityItems(
  course: CourseRef,
  snap: CourseSnapshot,
  opts: { now: number; toMs: number },
): DueItem[] {
  const out: DueItem[] = [];
  for (const sec of snap.s) {
    for (const m of sec.m) {
      if (!isUndatedPending(m)) continue;
      const opensMs = ms(m.d?.opens);
      if (opensMs !== null && opensMs > opts.toMs) continue;
      out.push(
        buildSweepItem({
          now: opts.now,
          course,
          kind: kindOf(m.t),
          cmid: m.c,
          name: m.n,
          url: m.u ?? '',
          opensMs,
          firstSeen: m.s,
        }),
      );
    }
  }
  return out;
}

/** Dates in a module name; a label's name is a cut-off copy of its text (scanned there), Moodle's own date wins. */
function moduleNameItems(course: CourseRef, m: SnapModule, win: TextWindow): DueItem[] {
  if (m.t === 'label' || m.v === 0 || m.k === 1) return [];
  if (PENDING_MODS.has(m.t) && hasOwnDeadline(m)) return [];
  const { now } = win;
  return findDeadlines(m.n, now, { max: 2, from: now - PAST_MENTION_MS })
    .filter((d) => inTextWindow(d.ms, win))
    .map((d) =>
      buildSweepItem({
        now,
        course,
        kind: kindOf(m.t),
        cmid: m.c,
        name: m.n,
        url: m.u ?? '',
        dueMs: d.ms,
        text: { evidence: d.evidence, sourceUrl: m.u },
        firstSeen: m.s,
      }),
    );
}

function nameItems(course: CourseRef, snap: CourseSnapshot, win: TextWindow): DueItem[] {
  return snap.s.flatMap((sec) => sec.m.flatMap((m) => moduleNameItems(course, m, win)));
}

/** Mentions of one text inside the window: stored at fetch time, parsed here only for snapshots stored before that. */
function mentionsOf(t: SnapText, win: TextWindow): TextDeadline[] {
  const all = t.d
    ? t.d.map(([ms, evidence, lead]) => ({ ms, evidence, lead }))
    : findDeadlines(t.x, win.now, { max: MENTIONS_PER_TEXT, from: win.now - PAST_MENTION_MS });
  return all.filter((d) => inTextWindow(d.ms, win)); // stored dates go stale until the next full refetch
}

/**
 * Deadlines of one text. Inside a task module's own description they belong to that module (real name, kind, cmid),
 * but only when Moodle gives the module no deadline and the text states one for it (see own-deadline.ts).
 */
function textItems(course: CourseRef, t: SnapText, opts: { task?: SnapModule; win: TextWindow }): DueItem[] {
  const { task, win } = opts;
  if (task && (task.k === 1 || task.v === 0 || hasOwnDeadline(task))) return []; // done / hidden / dated by Moodle
  const url = task?.u || t.u;
  return mentionsOf(t, win)
    .filter((d) => !task || isOwnDeadlineText(task, d.evidence))
    .map((d) =>
      buildSweepItem({
        now: win.now,
        course,
        kind: task ? kindOf(task.t) : 'other',
        cmid: task?.c ?? null,
        name: task ? task.n : titled(t.n, d.lead),
        url,
        dueMs: d.ms,
        text: { evidence: d.evidence, sourceUrl: url },
        firstSeen: t.s,
      }),
    );
}

function bodyItems(course: CourseRef, snap: CourseSnapshot, win: TextWindow): DueItem[] {
  const tasks = taskModules(snap);
  return snap.x.flatMap((t) =>
    textItems(course, t, { task: t.r.startsWith('m') ? tasks.get(Number(t.r.slice(1))) : undefined, win }),
  );
}

/** "<where found>: <trigger phrase>", e.g. "Week1 授業概要: 課題の提出". */
const titled = (where: string, lead: string) => (lead ? `${where}: ${lead}` : where);

/** The MAX_TEXT_ITEMS items due closest to `now` (past or future), in their original order. */
function nearestItems(items: DueItem[], now: number): DueItem[] {
  if (items.length <= MAX_TEXT_ITEMS) return items;
  const dist = (i: DueItem) => Math.abs((i.dueAt ? Date.parse(i.dueAt) : now) - now);
  const keep = new Set([...items].sort((a, b) => dist(a) - dist(b)).slice(0, MAX_TEXT_ITEMS));
  return items.filter((i) => keep.has(i));
}

/** (b) deadlines in module names, section summaries, labels, descriptions inside `win`, capped by closeness to now. */
export function textDeadlineItems(course: CourseRef, snap: CourseSnapshot, win: TextWindow): DueItem[] {
  return nearestItems([...nameItems(course, snap, win), ...bodyItems(course, snap, win)], win.now);
}
