/** DueItem construction for sweep results (flags computed like the calendar mapper in due.ts). */

import { isMidnight, isoJst } from '../../time';
import type { DueItem, DueKind } from '../../types';
import type { CourseRef } from './types';

const NEW_WINDOW_MS = 72 * 3_600_000;

const KIND_BY_MODULE: Record<string, DueKind> = {
  assign: 'assign',
  quiz: 'quiz',
  questionnaire: 'questionnaire',
  lesson: 'lesson',
  workshop: 'workshop',
  forum: 'forum',
  hsuforum: 'forum',
};

export const kindOf = (modname: string | null | undefined): DueKind => (modname && KIND_BY_MODULE[modname]) || 'other';

export interface SweepItemInput {
  now: number;
  course: CourseRef;
  kind: DueKind;
  cmid: number | null;
  name: string;
  url: string;
  opensMs?: number | null;
  dueMs?: number | null;
  /** Text items only: where the date was found. */
  text?: { evidence: string; sourceUrl: string | null };
  firstSeen?: number; // ms; undefined = unknown (counts as not new)
}

export function buildSweepItem(i: SweepItemInput): DueItem {
  const opens = i.opensMs ?? null;
  const due = i.dueMs ?? null;
  return {
    kind: i.kind,
    courseId: i.course.id,
    courseName: i.course.name,
    cmid: i.cmid,
    name: i.name,
    opensAt: opens === null ? null : isoJst(opens),
    dueAt: due === null ? null : isoJst(due),
    midnightDue: due !== null && isMidnight(due / 1000),
    overdue: due !== null && due < i.now,
    closed: false,
    notOpenYet: opens !== null && opens > i.now,
    url: i.url,
    action: null,
    source: i.text ? 'text' : 'activity',
    evidence: i.text?.evidence ?? null,
    sourceUrl: i.text?.sourceUrl ?? null,
    isNew: i.firstSeen !== undefined && i.now - i.firstSeen <= NEW_WINDOW_MS,
  };
}
