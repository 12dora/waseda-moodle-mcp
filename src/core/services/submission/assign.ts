/** Assignment progress from `mod_assign_get_submission_status`. */

import { isObj } from '../../moodle/wire';
import { fromTs } from '../../time';
import type { DueSubmission } from '../../types';
import type { BatchRequest } from './batch';

export const assignStatusRequest = (assignId: number): BatchRequest => ({
  fn: 'mod_assign_get_submission_status',
  args: { assignid: assignId },
});

const STATUS = new Map<string, DueSubmission['status']>([
  ['new', 'none'],
  ['draft', 'draft'],
  ['submitted', 'submitted'],
  ['reopened', 'reopened'],
]);

/** `lastattempt.teamsubmission` for team assignments (absent otherwise), else the user's own submission. */
function currentSubmission(last: Record<string, unknown>): Record<string, unknown> | null {
  const team = isObj(last.teamsubmission) ? last.teamsubmission : null;
  const own = isObj(last.submission) ? last.submission : null;
  return team ?? own;
}

/** null when the response has no readable submission status. */
export function parseAssignStatus(data: unknown): DueSubmission | null {
  const last = isObj(data) && isObj(data.lastattempt) ? data.lastattempt : null;
  const sub = last ? currentSubmission(last) : null;
  const status = typeof sub?.status === 'string' ? STATUS.get(sub.status) : undefined;
  if (!last || !status) return null;
  const canEdit = last.canedit === true;
  const canContinue = status === 'submitted' ? canEdit && last.locked !== true : canEdit;
  const timeModified = typeof sub?.timemodified === 'number' ? sub.timemodified : null;
  return {
    status,
    canContinue,
    submittedAt: status === 'submitted' ? fromTs(timeModified) : null,
    graded: last.gradingstatus === 'graded',
    note: status === 'draft' && last.cansubmit === true ? 'submit button not pressed' : null,
  };
}
