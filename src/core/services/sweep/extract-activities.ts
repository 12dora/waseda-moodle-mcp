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

function nameItems(course: CourseRef, snap: CourseSnapshot, now: number): DueItem[] {
  const out: DueItem[] = [];
  for (const sec of snap.s) {
    for (const m of sec.m) {
      if (m.t === 'label' || m.v === 0 || m.k === 1) continue; // a label's name is a cut-off copy of its text (scanned there)
      if (PENDING_MODS.has(m.t) && hasOwnDeadline(m)) continue; // Moodle's own date wins
      for (const d of findDeadlines(m.n, now, { max: 2 })) {
        out.push(
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
    }
  }
  return out;
}

/** Mentions of one text: stored at fetch time, parsed here only for snapshots stored before that. */
function mentionsOf(t: SnapText, now: number): TextDeadline[] {
  return t.d
    ? t.d.map(([ms, evidence, lead]) => ({ ms, evidence, lead }))
    : findDeadlines(t.x, now, { max: MENTIONS_PER_TEXT });
}

/**
 * Deadlines of one text. Inside a task module's own description they belong to that module (real name, kind, cmid),
 * but only when Moodle gives the module no deadline and the text states one for it (see own-deadline.ts).
 */
function textItems(course: CourseRef, t: SnapText, opts: { task?: SnapModule; now: number }): DueItem[] {
  const { task, now } = opts;
  if (task && (task.k === 1 || task.v === 0 || hasOwnDeadline(task))) return []; // done / hidden / dated by Moodle
  const url = task?.u || t.u;
  return mentionsOf(t, now)
    .filter((d) => !task || isOwnDeadlineText(task, d.evidence))
    .map((d) =>
      buildSweepItem({
        now,
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

function bodyItems(course: CourseRef, snap: CourseSnapshot, now: number): DueItem[] {
  const tasks = taskModules(snap);
  return snap.x.flatMap((t) =>
    textItems(course, t, { task: t.r.startsWith('m') ? tasks.get(Number(t.r.slice(1))) : undefined, now }),
  );
}

/** "<where found>: <trigger phrase>", e.g. "Week1 授業概要: 課題の提出". */
const titled = (where: string, lead: string) => (lead ? `${where}: ${lead}` : where);

/** (b) deadlines mentioned in module names, section summaries, labels and descriptions. */
export function textDeadlineItems(course: CourseRef, snap: CourseSnapshot, now: number): DueItem[] {
  return [...nameItems(course, snap, now), ...bodyItems(course, snap, now)].slice(0, MAX_TEXT_ITEMS);
}
