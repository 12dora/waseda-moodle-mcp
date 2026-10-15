/**
 * The user's own progress on due items: assignment submissions, quiz attempts, questionnaire answers.
 * The calendar keeps listing questionnaires after they are answered and quizzes whatever the attempts, so the
 * listing asks Moodle: round 1 resolves course modules to instance ids (one batched call), round 2 reads the
 * statuses (one more). Best effort: any failure leaves `submission: null`.
 */

import type { MoodleApi, ServiceContext } from '../../context';
import { isObj } from '../../moodle/wire';
import type { DueItem, DueSubmission } from '../../types';
import { assignStatusRequest, parseAssignStatus } from './assign';
import { type BatchRequest, type BatchResult, callBatch } from './batch';
import { parseQuestionnaire, questionnaireRequest } from './questionnaire';
import { parseQuizState, quizAccessRequest, quizAttemptsRequest } from './quiz';

type Kind = 'assign' | 'quiz' | 'questionnaire';
type Target = DueItem & { cmid: number; kind: Kind };
type Statuses = Map<number, DueSubmission | null>;

/** Most items checked per listing: keeps both rounds within one or two batched calls. */
const MAX_CHECKED = 40;
const CHECKED_KINDS: ReadonlySet<string> = new Set<Kind>(['assign', 'quiz', 'questionnaire']);

const isTarget = (i: DueItem): i is Target => i.cmid !== null && CHECKED_KINDS.has(i.kind) && !i.closed;

/** Distinct cmids, in listing order. */
function pickTargets(items: readonly DueItem[]): Target[] {
  const seen = new Set<number>();
  const out: Target[] = [];
  for (const item of items) {
    if (!isTarget(item) || seen.has(item.cmid)) continue;
    seen.add(item.cmid);
    out.push(item);
  }
  return out.slice(0, MAX_CHECKED);
}

// ------------------------------------------------------------------ round 1: cmid -> instance

/** `core_course_get_course_module` answers `{cm:{…}}`; only a module of the expected type counts. */
function instanceOf(data: unknown, kind: Kind): number | null {
  const cm = isObj(data) && isObj(data.cm) ? data.cm : data;
  if (!isObj(cm) || cm.modname !== kind) return null;
  return typeof cm.instance === 'number' && cm.instance > 0 ? cm.instance : null;
}

const moduleRequest = (t: Target): BatchRequest => ({ fn: 'core_course_get_course_module', args: { cmid: t.cmid } });

/** cmid -> instance id for the assignments and quizzes (questionnaires are read by cmid). */
async function resolveInstances(api: MoodleApi, targets: readonly Target[]): Promise<Map<number, number>> {
  const needed = targets.filter((t) => t.kind !== 'questionnaire');
  const results = await callBatch(api, needed.map(moduleRequest));
  const out = new Map<number, number>();
  needed.forEach((t, i) => {
    const res = results[i];
    const instance = res?.ok ? instanceOf(res.data, t.kind) : null;
    if (instance !== null) out.set(t.cmid, instance);
  });
  return out;
}

// ------------------------------------------------------------------ round 2: statuses

interface Job {
  cmid: number;
  kind: Kind;
  requests: BatchRequest[];
}

function requestsFor(t: Target, instance: number | undefined, moodleUserId: number): BatchRequest[] {
  if (t.kind === 'questionnaire') return [questionnaireRequest(t.cmid, moodleUserId)];
  if (instance === undefined) return [];
  if (t.kind === 'assign') return [assignStatusRequest(instance)];
  return [quizAttemptsRequest(instance), quizAccessRequest(instance)];
}

/** The first result carries the main data; a quiz adds its access information as the second. */
function parseJob(kind: Kind, results: readonly BatchResult[]): DueSubmission | null {
  const [main, extra] = results;
  if (!main?.ok) return null;
  if (kind === 'assign') return parseAssignStatus(main.data);
  if (kind === 'questionnaire') return parseQuestionnaire(main.data);
  return parseQuizState({ attempts: main.data, access: extra?.ok ? extra.data : null });
}

async function readStatuses(api: MoodleApi, targets: readonly Target[]): Promise<Statuses> {
  const instances = await resolveInstances(api, targets);
  const jobs: Job[] = targets.map((t) => ({
    cmid: t.cmid,
    kind: t.kind,
    requests: requestsFor(t, instances.get(t.cmid), api.moodleUserId),
  }));
  const results = await callBatch(
    api,
    jobs.flatMap((j) => j.requests),
  );
  const out: Statuses = new Map();
  let offset = 0;
  for (const job of jobs) {
    const mine = results.slice(offset, offset + job.requests.length);
    offset += job.requests.length;
    out.set(job.cmid, job.requests.length === 0 ? null : parseJob(job.kind, mine));
  }
  return out;
}

// ------------------------------------------------------------------ memo + apply

/** One lookup per cmid per request: the MCP tool and the console API may both list due items. */
const memos = new WeakMap<ServiceContext, Map<number, Promise<DueSubmission | null>>>();

function memoOf(ctx: ServiceContext): Map<number, Promise<DueSubmission | null>> {
  const found = memos.get(ctx);
  if (found) return found;
  const created = new Map<number, Promise<DueSubmission | null>>();
  memos.set(ctx, created);
  return created;
}

async function fetchStatuses(ctx: ServiceContext, targets: readonly Target[]): Promise<Statuses> {
  try {
    return await readStatuses(await ctx.moodle(), targets);
  } catch (e) {
    console.error('[waseda-moodle] submission check failed:', e instanceof Error ? e.name : typeof e);
    return new Map();
  }
}

async function statesFor(ctx: ServiceContext, targets: readonly Target[]): Promise<Statuses> {
  const memo = memoOf(ctx);
  const fresh = targets.filter((t) => !memo.has(t.cmid));
  if (fresh.length > 0) {
    const run = fetchStatuses(ctx, fresh);
    for (const t of fresh)
      memo.set(
        t.cmid,
        run.then((m) => m.get(t.cmid) ?? null),
      );
  }
  const out: Statuses = new Map();
  for (const t of targets) out.set(t.cmid, (await memo.get(t.cmid)) ?? null);
  return out;
}

/** A submitted item is no longer outstanding: it cannot be overdue. */
function withState(item: DueItem, state: DueSubmission | null): DueItem {
  return { ...item, submission: state, overdue: state?.status === 'submitted' ? false : item.overdue };
}

/**
 * Adds `submission` to assignments, quizzes and questionnaires (with a cmid, not closed); everything else keeps
 * its value. Never throws: on any failure the items come back unchanged.
 */
export async function attachSubmissions(ctx: ServiceContext, items: DueItem[]): Promise<DueItem[]> {
  try {
    const targets = pickTargets(items);
    if (targets.length === 0) return items;
    const states = await statesFor(ctx, targets);
    return items.map((item) => {
      if (!isTarget(item) || !states.has(item.cmid)) return item;
      return withState(item, states.get(item.cmid) ?? null);
    });
  } catch {
    return items;
  }
}
