/** Manual activity completion toggles. */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput, NeedsReconnect, NotFound } from '../../errors';
import { decodeEntities } from '../../html';
import type { ActionPreview } from '../../types';
import { listCourses } from '../courses';
import {
  type ActionOutcome,
  assertWriteAllowed,
  isRec,
  num,
  positiveInt,
  type Raw,
  refusal,
  savePreview,
  str,
} from './shared';

export interface PrepareCompletionInput {
  cmid: number;
  completed: boolean;
}

type CompletionPayload = {
  cmid: number;
  completed: boolean;
  url: string;
};

interface CourseModule {
  courseId: number;
  name: string;
  modname: string;
}

async function loadModule(api: MoodleApi, cmid: number): Promise<CourseModule> {
  const res = await api.call<Raw>('core_course_get_course_module', { cmid });
  const cm = isRec(res.cm) ? res.cm : null;
  const courseId = cm ? num(cm.course) : null;
  if (!cm || courseId === null) throw new NotFound('Activity not found.');
  const name = str(cm.name);
  return {
    courseId,
    name: name ? decodeEntities(name) : `activity ${cmid}`,
    modname: str(cm.modname) ?? 'course',
  };
}

/** Whether the activity is currently complete; throws unless completion is tracked manually. */
async function manualCompletionState(api: MoodleApi, courseId: number, cmid: number): Promise<boolean> {
  const res = await api.call<Raw>('core_completion_get_activities_completion_status', {
    courseid: courseId,
    userid: api.moodleUserId,
  });
  const statuses = Array.isArray(res.statuses) ? res.statuses : [];
  const entry = statuses.find((s): s is Raw => isRec(s) && num(s.cmid) === cmid);
  const tracking = entry ? num(entry.tracking) : null;
  if (!entry || (tracking !== 1 && tracking !== 2)) {
    throw new InvalidInput('This activity has no completion tracking.');
  }
  if (tracking === 2) {
    throw new InvalidInput('Completion of this activity is tracked automatically; it cannot be set by hand.');
  }
  return (num(entry.state) ?? 0) > 0;
}

async function courseNameOf(ctx: ServiceContext, courseId: number): Promise<string> {
  const fallback = `course ${courseId}`;
  try {
    const courses = await listCourses(ctx, { classification: 'all', includeHidden: true });
    return courses.find((c) => c.id === courseId)?.name ?? fallback;
  } catch (e) {
    if (e instanceof NeedsReconnect) throw e;
    return fallback;
  }
}

export async function prepareCompletion(ctx: ServiceContext, input: PrepareCompletionInput): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  const cmid = positiveInt(input.cmid, 'cmid');
  if (typeof input.completed !== 'boolean') throw new InvalidInput('completed must be true or false.');
  const api = await ctx.moodle();
  const cm = await loadModule(api, cmid);
  const wasDone = await manualCompletionState(api, cm.courseId, cmid);
  const courseName = await courseNameOf(ctx, cm.courseId);
  const state = input.completed ? 'complete' : 'incomplete';
  const payload: CompletionPayload = {
    cmid,
    completed: input.completed,
    url: `${api.baseUrl}/mod/${cm.modname}/view.php?id=${cmid}`,
  };
  return savePreview(ctx, {
    kind: 'completion',
    title: `Mark '${cm.name}' ${state}`,
    details: [`Activity: ${cm.name} (${courseName})`, `Mark as: ${input.completed ? 'complete' : 'not complete'}`],
    warnings: wasDone === input.completed ? [`It is already marked ${state}.`] : [],
    payload,
  });
}

export async function executeCompletion(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as CompletionPayload;
  const res = await api.call<Raw>('core_completion_update_activity_completion_status_manually', {
    cmid: p.cmid,
    completed: p.completed,
  });
  if (isRec(res) && res.status === false) throw refusal('did not change the completion state', res);
  return { message: p.completed ? 'Marked complete.' : 'Marked incomplete.', url: p.url };
}
