/**
 * Due-item statuses on the web channel, where every status read is a page and Moodle serialises them (~1 s each):
 * assignments from the course's activity overview (ONE page per course for all its assignments and quizzes:
 * `submissionstatus` and the grade column), quizzes from their view page (the attempts and the access information
 * share it, through callBatch), questionnaires from their index page. No instance ids are resolved first (on this
 * channel they are the cmids). Only the plan's nearest quizzes get a view page; a quiz beyond that is answered from its
 * course's overview page when one is read anyway and shows its grade (a finished attempt), else stays unchecked. The
 * reads are bounded by the plan and by what the call budget has left (RESERVE calls stay for the rest of the tool),
 * nearest deadlines first; the rest stays unchecked (null), like any failed read.
 *
 * Plans (WebStatusMode): 'full' (the due list) as above. 'light' (the console's course overview, which lists every
 * course over 90 days) reads at most LIGHT_PAGES pages: questionnaires come from their course's overview page too
 * (`responded`: answered or not; a saved draft reads as not answered), and only the nearest quizzes get a view page.
 */

import type { MoodleApi } from '../../context';
import { readOverview } from '../../moodle/web/parse/overview';
import type { DueSubmission } from '../../types';
import { webSessionOf } from '../activity/web';
import { callBatch, mapLimit } from './batch';
import { parseWebQuestionnaireIndex } from './questionnaire-web';
import { parseQuizState, quizAccessRequest, quizAttemptsRequest } from './quiz';

type Kind = 'assign' | 'quiz' | 'questionnaire';

interface WebTarget {
  cmid: number;
  courseId: number;
  kind: Kind;
}

type Found = Array<[number, DueSubmission | null]>;

/** How many pages a listing may spend on statuses (see the module comment). */
export type WebStatusMode = 'full' | 'light';

interface Plan {
  /** Status pages at most (what the call budget leaves bounds them too). */
  maxPages: number;
  /** Quiz view pages (nearest deadlines): each costs a serialised page of ~1 s. */
  maxQuizPages: number;
  /** Kinds answered from their course's overview page: one page per course answers all of them. */
  byCourse: ReadonlySet<Kind>;
  /** The overview types that page expands (sorted: readOverview builds the same path from them). */
  types: readonly string[];
}

/** The light plan's pages: with the overview's fixed reads (courses, calendar) about 8 s on the web session. */
const LIGHT_PAGES = 6;

const PLANS: Readonly<Record<WebStatusMode, Plan>> = {
  full: {
    maxPages: Number.POSITIVE_INFINITY,
    maxQuizPages: 6,
    byCourse: new Set(['assign']),
    types: ['assign', 'quiz'],
  },
  light: {
    maxPages: LIGHT_PAGES,
    maxQuizPages: 2,
    byCourse: new Set(['assign', 'questionnaire']),
    types: ['assign', 'questionnaire', 'quiz'],
  },
};

/** The client's default budget (MoodleClient / WebMoodleClient maxCalls). */
const CLIENT_CALLS = 40;
const RESERVE = 6;
const CONCURRENCY = 6;

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

interface OverviewRow {
  values: Record<string, string>;
  text: Record<string, string>;
}

/** An overview row; null when its status text is not one this server knows (another language, a new string). */
function assignState(row: OverviewRow): DueSubmission | null {
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

/** A questionnaire row: `responded` is 1 once the user answered (a saved, unsent draft reads as not answered). */
function questionnaireOverviewState(row: { values: Record<string, string> }): DueSubmission | null {
  const responded = row.values.responded;
  if (responded !== '1' && responded !== '0') return null;
  const answered = responded === '1';
  const status = answered ? 'submitted' : 'none';
  return { status, canContinue: !answered, submittedAt: null, graded: false, note: null };
}

const OVERVIEW_STATE: Readonly<Record<Kind, (row: OverviewRow) => DueSubmission | null>> = {
  assign: assignState,
  quiz: quizOverviewState,
  questionnaire: questionnaireOverviewState,
};

interface OverviewEntry {
  cmid: number;
  kind: Kind;
}

/** One course's overview page for the entries planned on it (the types the plan expands). */
async function courseOverview(
  api: MoodleApi,
  page: { courseId: number; types: readonly string[] },
  entries: readonly OverviewEntry[],
): Promise<Found> {
  const rows = await readOverview(webSessionOf(api), page.courseId, page.types).catch(() => null);
  return entries.map(({ cmid, kind }): [number, DueSubmission | null] => {
    const row = rows?.get(cmid);
    return [cmid, row ? OVERVIEW_STATE[kind](row) : null];
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

/** One listing's planning: its plan and the course overview pages planned so far (their entries, by course). */
interface Planning {
  api: MoodleApi;
  plan: Plan;
  courses: Map<number, OverviewEntry[]>;
}

/** The read that answers one target on its own page (its course's overview page, a quiz or questionnaire page). */
function ownJob(p: Planning, t: WebTarget): () => Promise<Found> {
  const { api } = p;
  if (p.plan.byCourse.has(t.kind)) {
    const entries: OverviewEntry[] = [{ cmid: t.cmid, kind: t.kind }];
    p.courses.set(t.courseId, entries);
    return () => courseOverview(api, { courseId: t.courseId, types: p.plan.types }, entries);
  }
  return t.kind === 'quiz' ? () => quizStatus(api, t.cmid) : () => questionnaireStatus(api, t.cmid);
}

/**
 * The reads that fit the plan and the budget, in target order: a target of a `byCourse` kind costs its course's
 * overview page once; a quiz beyond the plan's quiz pages only joins an overview page planned anyway (never one of its
 * own). Entries are collected before any job runs, so a later target joins an earlier page.
 */
function plan(api: MoodleApi, targets: readonly WebTarget[], mode: WebStatusMode): Array<() => Promise<Found>> {
  const p: Planning = { api, plan: PLANS[mode], courses: new Map() };
  let left = Math.min(p.plan.maxPages, Math.max(0, CLIENT_CALLS - api.callsMade - RESERVE));
  let quizPages = 0;
  const extraQuizzes: WebTarget[] = [];
  const jobs: Array<() => Promise<Found>> = [];
  for (const t of targets) {
    const listed = p.plan.byCourse.has(t.kind) ? p.courses.get(t.courseId) : undefined;
    if (listed) listed.push({ cmid: t.cmid, kind: t.kind });
    else if (t.kind === 'quiz' && quizPages >= p.plan.maxQuizPages) extraQuizzes.push(t);
    else if (left > 0) {
      left--;
      if (t.kind === 'quiz') quizPages++;
      jobs.push(ownJob(p, t));
    }
  }
  for (const t of extraQuizzes) p.courses.get(t.courseId)?.push({ cmid: t.cmid, kind: 'quiz' });
  return jobs;
}

/** Statuses by cmid for the targets read (nearest first); targets left out of the plan or the budget are absent. */
export async function readWebStatuses(
  api: MoodleApi,
  targets: readonly WebTarget[],
  mode: WebStatusMode = 'full',
): Promise<Map<number, DueSubmission | null>> {
  const found = await mapLimit(plan(api, targets, mode), CONCURRENCY, (job) => job());
  return new Map(found.flat());
}
