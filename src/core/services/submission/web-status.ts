/**
 * Due-item statuses on the web channel, where every status read is a page: assignments from the course's activity
 * overview (ONE page per course for all its assignments: `submissionstatus` and the grade column), quizzes from
 * their view page (the attempts and the access information share it, through callBatch), questionnaires from their
 * index page. No instance ids are resolved first (on this channel they are the cmids). The
 * reads are bounded by what the call budget has left (RESERVE calls stay for the rest of the tool), nearest
 * deadlines first; the rest stays unchecked (null), like any failed read.
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

async function courseAssignments(api: MoodleApi, courseId: number, cmids: readonly number[]): Promise<Found> {
  const rows = await readOverview(webSessionOf(api), courseId, ['assign']).catch(() => null);
  return cmids.map((cmid) => {
    const row = rows?.get(cmid);
    return [cmid, row ? assignState(row) : null];
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

/** The reads that fit the budget, in target order: an assignment costs its course's overview page once. */
function plan(api: MoodleApi, targets: readonly WebTarget[]): Array<() => Promise<Found>> {
  let left = Math.max(0, CLIENT_CALLS - api.callsMade - RESERVE);
  const courses = new Map<number, number[]>();
  const jobs: Array<() => Promise<Found>> = [];
  for (const t of targets) {
    const listed = t.kind === 'assign' ? courses.get(t.courseId) : undefined;
    if (listed) {
      listed.push(t.cmid);
      continue;
    }
    if (left === 0) continue;
    left--;
    if (t.kind === 'assign') {
      const cmids = [t.cmid];
      courses.set(t.courseId, cmids);
      jobs.push(() => courseAssignments(api, t.courseId, cmids));
    } else {
      jobs.push(() => (t.kind === 'quiz' ? quizStatus(api, t.cmid) : questionnaireStatus(api, t.cmid)));
    }
  }
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
