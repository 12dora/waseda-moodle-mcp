/** Synthetic AssignDetail (shape of services/activity.ts output) for the BE-4 tests. */

import type { AssignDetail, SubmissionState } from '../../../src/core/types';

export const ASSIGN_CMID = 5001;
export const ASSIGN_INSTANCE = 7001;

export function makeSubmission(overrides: Partial<SubmissionState> = {}): SubmissionState {
  return {
    status: 'new',
    gradingStatus: null,
    lastModified: null,
    onlineText: null,
    files: [],
    canEdit: true,
    canSubmit: true,
    locked: false,
    extensionDue: null,
    ...overrides,
  };
}

/** Due 2026-10-20 23:59 JST, open since 2026-10-01; file + onlinetext, drafts on, no statement. */
export function makeAssign(overrides: Partial<AssignDetail> = {}): AssignDetail {
  return {
    type: 'assign',
    cmid: ASSIGN_CMID,
    instanceId: ASSIGN_INSTANCE,
    courseId: 301,
    courseName: 'Strategic Marketing',
    name: 'Report 3',
    url: `https://wsdmoodle.waseda.jp/mod/assign/view.php?id=${ASSIGN_CMID}`,
    description: 'Write a short valuation memo.',
    attachments: [],
    opensAt: '2026-10-01T00:00:00+09:00',
    dueAt: '2026-10-20T23:59:00+09:00',
    cutoffAt: null,
    submissionTypes: ['onlinetext', 'file'],
    maxFiles: 3,
    maxFileBytes: 10 * 1024 * 1024,
    acceptedTypes: ['.pdf', '.docx'],
    wordLimit: null,
    draftsEnabled: true,
    requiresStatement: false,
    statement: null,
    teamSubmission: false,
    submission: makeSubmission(),
    feedback: null,
    ...overrides,
  };
}

/** mod_assign_get_submission_status response (only the fields the code reads). */
export function statusResponse(status: 'new' | 'draft' | 'submitted') {
  return { lastattempt: { submission: { id: 11, status, plugins: [] }, canedit: true }, warnings: [] };
}
