/** Grades for courses whose gradebook is hidden: collected from assignment feedback and quiz results. */

import type { MoodleApi } from '../context';
import { MoodleError, MoodleUnavailable } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import { fromTs, nowSec } from '../time';
import type { GradeItem } from '../types';
import { cleanDisplay } from './grade-format';

const ASSIGNMENTS_FN = 'mod_assign_get_assignments';
const SUBMISSION_STATUS_FN = 'mod_assign_get_submission_status';
const QUIZZES_FN = 'mod_quiz_get_quizzes_by_courses';
const BEST_GRADE_FN = 'mod_quiz_get_user_best_grade';

const MAX_ASSIGNMENTS = 15;
const MAX_QUIZZES = 10;

interface RawAssignment {
  id?: number;
  cmid?: number;
  name?: string;
  duedate?: number;
  grade?: number; // max grade; <= 0 means scale/none
}

interface RawFeedback {
  gradefordisplay?: string | null;
  gradeddate?: number | null;
  grade?: { grade?: string | number | null; timemodified?: number | null } | null;
  plugins?: Array<{ type?: string; editorfields?: Array<{ text?: string }> | null }> | null;
}

interface RawSubmissionStatus {
  feedback?: RawFeedback | null;
}

interface RawQuiz {
  id?: number;
  coursemodule?: number;
  name?: string;
  grade?: number;
  timeopen?: number;
  timeclose?: number;
}

interface RawBestGrade {
  hasgrade?: boolean;
  grade?: number | string | null;
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '');
const num2 = (n: number) => n.toFixed(2);
const percent = (grade: number, max: number) => `${num2((grade / max) * 100)} %`;
const maxGrade = (g: number | undefined) => (typeof g === 'number' && g > 0 ? g : null);

/** Raw numeric grade; Moodle stores -1 for "not graded". */
function rawGrade(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function feedbackComments(fb: RawFeedback): string | null {
  const parts: string[] = [];
  for (const plugin of fb.plugins ?? []) {
    if (plugin.type !== 'comments') continue;
    for (const field of plugin.editorfields ?? []) {
      const md = field.text ? htmlToMarkdown(field.text) : '';
      if (md) parts.push(md);
    }
  }
  return parts.length ? parts.join('\n\n') : null;
}

/** Item from an assignment's feedback; null when there is neither a grade nor feedback comments. */
export function mapAssignGrade(a: RawAssignment, status: RawSubmissionStatus | null | undefined): GradeItem | null {
  const fb = status?.feedback;
  if (!fb) return null;
  const raw = rawGrade(fb.grade?.grade);
  const max = maxGrade(a.grade);
  const shown = cleanDisplay(fb.gradefordisplay ? stripTags(fb.gradefordisplay) : null);
  const grade = shown ?? (raw === null ? null : num2(raw));
  const feedback = feedbackComments(fb);
  if (grade === null && feedback === null) return null;
  return {
    name: decodeEntities(a.name ?? '') || '(unnamed)',
    itemType: 'mod',
    modname: 'assign',
    cmid: a.cmid || null,
    grade,
    range: max === null ? null : `0–${max}`,
    percentage: raw !== null && max !== null ? percent(raw, max) : null,
    feedback,
    weight: null,
    gradedAt: fromTs(fb.gradeddate || fb.grade?.timemodified),
  };
}

/** Quiz best grade; null when the user has no grade (`hasgrade` false). */
export function mapQuizGrade(q: RawQuiz, best: RawBestGrade | null | undefined): GradeItem | null {
  const value = best?.hasgrade ? rawGrade(best.grade) : null;
  if (value === null) return null;
  const max = maxGrade(q.grade);
  return {
    name: decodeEntities(q.name ?? '') || '(unnamed)',
    itemType: 'mod',
    modname: 'quiz',
    cmid: q.coursemodule || null,
    grade: max === null ? num2(value) : `${num2(value)} / ${num2(max)}`,
    range: max === null ? null : `0–${max}`,
    percentage: max === null ? null : percent(value, max),
    feedback: null,
    weight: null,
    gradedAt: null,
  };
}

/** Assignments whose deadline passed first (newest first), then undated ones, then upcoming (soonest first). */
function rankAssignments(list: RawAssignment[], now: number): RawAssignment[] {
  const due = (a: RawAssignment) => a.duedate || 0;
  const bucket = (a: RawAssignment) => {
    if (!due(a)) return 1;
    return due(a) <= now ? 0 : 2;
  };
  return [...list].sort((a, b) => {
    const diff = bucket(a) - bucket(b);
    if (diff) return diff;
    return bucket(a) === 2 ? due(a) - due(b) : due(b) - due(a);
  });
}

/** Quizzes by closing (else opening) time, newest first. */
function rankQuizzes(list: RawQuiz[]): RawQuiz[] {
  const when = (q: RawQuiz) => q.timeclose || q.timeopen || 0;
  return [...list].sort((a, b) => when(b) - when(a));
}

/** Unused quiz slots go to assignments and vice versa; never more than MAX_ASSIGNMENTS + MAX_QUIZZES in total. */
function allocateSlots(assignments: number, quizzes: number): { assigns: number; quizzes: number } {
  return {
    assigns: Math.min(assignments, MAX_ASSIGNMENTS + Math.max(0, MAX_QUIZZES - quizzes)),
    quizzes: Math.min(quizzes, MAX_QUIZZES + Math.max(0, MAX_ASSIGNMENTS - assignments)),
  };
}

/** A failing activity (permissions, module disabled, Moodle down) must not sink the whole report. */
async function orSkip<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof MoodleError || e instanceof MoodleUnavailable) return null;
    throw e;
  }
}

const present = (i: GradeItem | null): i is GradeItem => i !== null;

/**
 * At most 2 list calls + 25 per-activity calls. `unchecked` counts activities left out by the caps.
 * Assignments: deadline-passed first; quizzes: newest first.
 */
export async function collectActivityGrades(
  api: MoodleApi,
  courseId: number,
): Promise<{ items: GradeItem[]; unchecked: number }> {
  const [assignRes, quizRes] = await Promise.all([
    orSkip(api.call<{ courses?: Array<{ assignments?: RawAssignment[] }> }>(ASSIGNMENTS_FN, { courseids: [courseId] })),
    orSkip(api.call<{ quizzes?: RawQuiz[] }>(QUIZZES_FN, { courseids: [courseId] })),
  ]);
  const assignments = rankAssignments(
    (assignRes?.courses ?? []).flatMap((c) => c.assignments ?? []).filter((a) => a.id),
    nowSec(),
  );
  const quizzes = rankQuizzes((quizRes?.quizzes ?? []).filter((q) => q.id));
  const take = allocateSlots(assignments.length, quizzes.length);

  const [assignItems, quizItems] = await Promise.all([
    Promise.all(
      assignments.slice(0, take.assigns).map(async (a) => {
        const status = await orSkip(api.call<RawSubmissionStatus>(SUBMISSION_STATUS_FN, { assignid: a.id }));
        return mapAssignGrade(a, status);
      }),
    ),
    Promise.all(
      quizzes.slice(0, take.quizzes).map(async (q) => {
        const best = await orSkip(api.call<RawBestGrade>(BEST_GRADE_FN, { quizid: q.id }));
        return mapQuizGrade(q, best);
      }),
    ),
  ]);
  return {
    items: [...assignItems, ...quizItems].filter(present),
    unchecked: assignments.length - take.assigns + (quizzes.length - take.quizzes),
  };
}
