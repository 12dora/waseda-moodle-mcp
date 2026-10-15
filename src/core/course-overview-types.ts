/**
 * Console "My courses" payload (contract §6.3). Nested in core/types so the SPA can re-export it.
 */

import type { DueCounts } from './services/due-groups';
import type { Course, CourseUpdate, DueItem, IsoJst, TimetableSource } from './types';

/** One weekly meeting: weekday 1 = Monday … 7 = Sunday; start/end 'HH:MM' JST from the official period table. */
export interface CourseSlot {
  weekday: number;
  periodFrom: number;
  periodTo: number;
  start: string | null;
  end: string | null;
  classroom: string | null;
  campus: string | null;
}

export interface CourseSchedule {
  slots: CourseSlot[];
  listing: 'on-demand' | 'no-fixed-time' | null;
  alsoInClass: boolean;
  /** null = class time unknown. */
  source: TimetableSource | null;
}

export interface GradingRow {
  method: string;
  weight: number | null;
  criteria: string;
}

/** One course of GET /api/courses/overview. */
export interface CourseOverviewItem {
  id: number;
  name: string;
  url: string;
  term: string | null;
  kind: Course['kind'];
  schedule: CourseSchedule;
  syllabusUrl: string | null;
  grading: GradingRow[] | null;
  gradingText: string | null;
  /** 'unknown' = no cached syllabus result (the console may fetch /api/syllabus); 'not-found' = cached negative. */
  syllabusStatus: 'found' | 'not-found' | 'unknown';
  counts: DueCounts;
  items: DueItem[];
  updates: CourseUpdate[];
}

/** GET /api/courses/overview. */
export interface CourseOverview {
  generatedAt: IsoJst;
  scopeMode: 'mine' | 'auto';
  /** The live due fetch failed: every course's items and counts are empty. */
  dueError: boolean;
  courses: CourseOverviewItem[];
}

/** GET /api/syllabus?course_id=. */
export interface SyllabusSummary {
  courseId: number;
  url: string | null;
  grading: GradingRow[] | null;
  gradingText: string | null;
  status: 'found' | 'not-found' | 'error';
}
