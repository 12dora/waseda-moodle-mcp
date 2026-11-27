/**
 * Due-item statuses on the web channel, where every status read is a page and Moodle serialises them (~1 s each):
 * assignments from the course's activity overview (ONE page per course for all its assignments and quizzes:
 * `submissionstatus` and the grade column), quizzes from their view page (the attempts and the access information
 * share it, through callBatch), questionnaires from their index page. No instance ids are resolved first (on this
 * channel they are the cmids). Only the MAX_QUIZ_PAGES nearest quizzes get a view page; a quiz beyond that is answered
 * from its course's overview page when one is read anyway and shows its grade (a finished attempt), else stays
 * unchecked. The reads are bounded by what the call budget has left (RESERVE calls stay for the rest of the tool),
 * nearest deadlines first; the rest stays unchecked (null), like any failed read.
 */

import type { MoodleApi } from '../../context';
import { readOverview } from '../../moodle/web/parse/overview';
import type { DueSubmission } from '../../types';
import { webSessionOf } from '../activity/web';
import { callBatch, mapLimit } from './batch';
import { parseWebQuestionnaireIndex } from './questionnaire-web';
import { parseQuizState, quizAccessRequest, quizAttemptsRequest } from './quiz';

interface WebTarget {
  cmid: number;
  courseId: number;
  kind: 'assign' | 'quiz' | 'questionnaire';
}

type Found = Array<[number, DueSubmission | null]>;

/** The client's default budget (MoodleClient / WebMoodleClient maxCalls). */
const CLIENT_CALLS = 40;
const RESERVE = 6;
const CONCURRENCY = 6;
/** Quiz view pages per listing (nearest deadlines): each costs a serialised page of ~1 s. */
const MAX_QUIZ_PAGES = 6;
/** The overview types read for statuses: one page answers the course's assignments and quizzes. */
const OVERVIEW_TYPES = ['assign', 'quiz'] as const;

/** `submissionstatus` as the overview prints it (mod_assign submissionstatus_* strings, en and ja). */
const ASSIGN_STATUS: ReadonlyArray<[RegExp, DueSubmission['status'], boolean]> = [
  [/^(?:submitted for grading|評定のために提出済み)$/i, 'submitted', false],
  [/^(?:graded|評定済み)$/i, 'submitted', true],
  [/^(?:draft \(not submitted\)|下書き\s*[(（]未提出[)）])$/i, 'draft', false],
  [/^(?:no submission|no attempt|提出なし|未提出)$/i, 'none', false],
  [/^(?:reopened|再オープン(?:済み)?)$/i, 'reopened', false],
];

/** A grade cell holds a number once graded; '-' or '' means not graded. */
const hasGrade = (value: string | undefined): boolean => /\d/.test(value ?? '');

/** An overview row; null when its status text is not one this server knows (another language, a new string). */
function assignState(row: { values: Record<string, string>; text: Record<string, string> }): DueSubmission | null {
  const shown = (row.values.submissionstatus ?? row.text.submissionstatus ?? '').trim();
  const known = ASSIGN_STATUS.find(([re]) => re.test(shown));
  if (!known) return null;
  const [, status, graded] = known;
  // whether Moodle still lets the user edit is not shown there
  return { status, canContinue: false, submittedAt: null, graded: graded || hasGrade(row.values.grade), note: null };
}

/**
 * A quiz overview row shows the user's grade only: a grade means a finished attempt. Whether another attempt is
 * allowed or one is in progress is not shown, so no grade (or a quiz awaiting manual grading) stays unknown.
 */
function quizOverviewState(row: { values: Record<string, string> }): DueSubmission | null {
  if (!hasGrade(row.values.grade)) return null;
  return { status: 'submitted', canContinue: false, submittedAt: null, graded: true, note: null };
}

interface OverviewEntry {
  cmid: number;
  kind: 'assign' | 'quiz';
}

async function courseOverview(api: MoodleApi, courseId: number, entries: readonly OverviewEntry[]): Promise<Found> {
  const rows = await readOverview(webSessionOf(api), courseId, OVERVIEW_TYPES).catch(() => null);
  return entries.map(({ cmid, kind }): [number, DueSubmission | null] => {
    const row = rows?.get(cmid);
    if (!row) return [cmid, null];
    return [cmid, kind === 'assign' ? assignState(row) : quizOverviewState(row)];
  });
}

/** On the web channel a quiz's instance is its cmid; both reads come from its view page (one request). */
async function quizStatus(api: MoodleApi, cmid: number): Promise<Found> {
  const hint = { cmid };
  const [attempts, access] = await callBatch(api, [
    { ...quizAttemptsRequest(cmid), hint },
    { ...quizAccessRequest(cmid), hint },
  ]);
  if (!attempts?.ok) return [[cmid, null]];
  return [[cmid, parseQuizState({ attempts: attempts.data, access: access?.ok ? access.data : null })]];
}

async function questionnaireStatus(api: MoodleApi, cmid: number): Promise<Found> {
  const page = await webSessionOf(api)
    .page(`/mod/questionnaire/view.php?id=${cmid}`)
    .catch(() => null);
  return [[cmid, page ? parseWebQuestionnaireIndex(page.html, api.baseUrl).state : null]];
}

/**
 * The reads that fit the budget, in target order: an assignment costs its course's overview page once; a quiz beyond
 * MAX_QUIZ_PAGES only joins an overview page planned anyway (never one of its own). Entries are collected before any
 * job runs, so a later target joins an earlier page.
 */
/** The read that answers one target on its own page (an assignment's course overview, a quiz or questionnaire page). */
function ownJob(api: MoodleApi, t: WebTarget, courses: Map<number, OverviewEntry[]>): () => Promise<Found> {
  if (t.kind === 'assign') {
    const entries: OverviewEntry[] = [{ cmid: t.cmid, kind: 'assign' }];
    courses.set(t.courseId, entries);
    return () => courseOverview(api, t.courseId, entries);
  }
  return t.kind === 'quiz' ? () => quizStatus(api, t.cmid) : () => questionnaireStatus(api, t.cmid);
}

function plan(api: MoodleApi, targets: readonly WebTarget[]): Array<() => Promise<Found>> {
  let left = Math.max(0, CLIENT_CALLS - api.callsMade - RESERVE);
  let quizPages = 0;
  const courses = new Map<number, OverviewEntry[]>();
  const extraQuizzes: WebTarget[] = [];
  const jobs: Array<() => Promise<Found>> = [];
  for (const t of targets) {
    const listed = t.kind === 'assign' ? courses.get(t.courseId) : undefined;
    if (listed) listed.push({ cmid: t.cmid, kind: 'assign' });
    else if (t.kind === 'quiz' && quizPages >= MAX_QUIZ_PAGES) extraQuizzes.push(t);
    else if (left > 0) {
      left--;
      if (t.kind === 'quiz') quizPages++;
      jobs.push(ownJob(api, t, courses));
    }
  }
  for (const t of extraQuizzes) courses.get(t.courseId)?.push({ cmid: t.cmid, kind: 'quiz' });
  return jobs;
}

/** Statuses by cmid for the targets read (nearest first); targets left out of the budget are absent. */
export async function readWebStatuses(
  api: MoodleApi,
  targets: readonly WebTarget[],
): Promise<Map<number, DueSubmission | null>> {
  const found = await mapLimit(plan(api, targets), CONCURRENCY, (job) => job());
  return new Map(found.flat());
}
