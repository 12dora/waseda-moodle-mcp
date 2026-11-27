/**
 * mod_assign on the web channel. The assignment "instance id" is the cmid (design.md, instance ids): `assignid` /
 * `assignmentid` are cmids here, and mod_assign_get_assignments answers `id: cmid`.
 *   get_assignments   with hint.cmid: the view page (+ the edit form while the user can edit, + the submit confirm
 *                     form when the assignment may have a draft stage: it holds the submission statement);
 *                     without: the course's activity overview (id/cmid/name/duedate only).
 *   get_submission_status  the view page's status and feedback tables.
 *   save_submission / submit_for_grading  the edit form / the submit confirm form, read fresh and posted back.
 */

import type { CallHint } from '../../../context';
import { MoodleError } from '../../../errors';
import { pageConfig, text } from '../html';
import {
  type AssignEditForm,
  type AssignForm,
  type AssignView,
  formErrors,
  parseAssignView,
  parseEditForm,
  parseSubmitForm,
} from '../parse/assign-page';
import { readOverview } from '../parse/overview';
import type { WebFunctions, WebSession } from '../types';

type Params = Record<string, unknown>;

interface Warning {
  item: string;
  itemid: number;
  warningcode: string;
  message: string;
}

const viewPath = (cmid: number, action?: string): string =>
  `/mod/assign/view.php?id=${cmid}${action ? `&action=${action}` : ''}`;

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function idParam(v: unknown): number {
  if (!isId(v)) throw new MoodleError('Invalid assignment id.', 'invalidparameter');
  return v;
}

const isRec = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Only the user's own pages exist on the web channel. */
function assertOwnUser(web: WebSession, userid: unknown): void {
  if (userid !== undefined && userid !== null && userid !== 0 && userid !== web.moodleUserId) {
    throw new MoodleError("Another user's submission is not available.", 'nopermissions');
  }
}

/** A page that may be missing for this user (form not offered): null instead of the Moodle error. */
async function optionalPage(web: WebSession, path: string): Promise<string | null> {
  try {
    return (await web.page(path)).html;
  } catch (e) {
    if (e instanceof MoodleError) return null;
    throw e;
  }
}

// ------------------------------------------------------------------ mod_assign_get_assignments

/**
 * The draft stage, from what the pages show: a submit button or a draft means drafts; a statement on the edit form
 * (Moodle puts it there only without drafts) or an editable submitted attempt means none. Otherwise null: the pages
 * do not tell (a new attempt without a statement looks the same either way), and the save may submit at once.
 */
function draftsSetting(view: AssignView, edit: AssignEditForm | null): 0 | 1 | null {
  if (view.canSubmit || view.status?.status === 'draft') return 1;
  if (edit && edit.statement !== null) return 0;
  return view.status?.status === 'submitted' && view.canEdit ? 0 : null;
}

const subConfig = (plugin: string, name: string, value: string) => ({
  plugin,
  subtype: 'assignsubmission',
  name,
  value,
});

/** From the edit form when it was readable, else the plugins the status table shows (enabled only). */
function submissionConfigs(view: AssignView, edit: AssignEditForm | null) {
  if (!edit) {
    const shown = (view.status?.plugins ?? []).map((p) => p.type).filter((t) => t === 'onlinetext' || t === 'file');
    return shown.map((t) => subConfig(t, 'enabled', '1'));
  }
  const out = [
    subConfig('onlinetext', 'enabled', edit.onlinetext ? '1' : '0'),
    subConfig('file', 'enabled', edit.file ? '1' : '0'),
  ];
  if (!edit.file) return out;
  if (edit.maxFiles) out.push(subConfig('file', 'maxfilesubmissions', String(edit.maxFiles)));
  if (edit.maxBytes) out.push(subConfig('file', 'maxsubmissionsizebytes', String(edit.maxBytes)));
  out.push(subConfig('file', 'filetypeslist', edit.fileTypes));
  return out;
}

/** The maximum grade from a graded "85.00 / 100.00"; undefined when not shown. */
function maxGrade(view: AssignView): number | undefined {
  const m = /\/\s*(\d+(?:\.\d+)?)\s*$/.exec(text(view.feedback?.gradefordisplay ?? ''));
  return m ? Number(m[1]) : undefined;
}

async function statementForm(web: WebSession, cmid: number, view: AssignView, drafts: 0 | 1 | null) {
  if (drafts === 0 || !(view.canEdit || view.canSubmit)) return null;
  const html = await optionalPage(web, viewPath(cmid, 'submit'));
  return html ? parseSubmitForm(html, web.baseUrl) : null;
}

async function oneAssignment(web: WebSession, cmid: number, courseIds: number[]) {
  const html = (await web.page(viewPath(cmid))).html;
  const view = parseAssignView(html, pageConfig(html).courseId);
  const course = view.courseId ?? courseIds[0] ?? 0;
  if (courseIds.length > 0 && !courseIds.includes(course)) return [];
  const editHtml = view.canEdit ? await optionalPage(web, viewPath(cmid, 'editsubmission')) : null;
  const edit = editHtml ? parseEditForm(editHtml, web.baseUrl) : null;
  const drafts = draftsSetting(view, edit);
  const statement = edit?.statement ?? (await statementForm(web, cmid, view, drafts))?.statement ?? null;
  const assignment = {
    id: cmid,
    cmid,
    course,
    name: view.name,
    intro: view.intro,
    introformat: 1,
    introattachments: view.introFiles,
    activityattachments: view.activityFiles,
    duedate: view.dueAt,
    allowsubmissionsfromdate: view.opensAt,
    submissiondrafts: drafts,
    teamsubmission: 0,
    requiresubmissionstatement: statement === null ? 0 : 1,
    submissionstatement: statement ?? '',
    configs: submissionConfigs(view, edit),
    grade: maxGrade(view),
  };
  return [{ id: course, assignments: [assignment] }];
}

async function courseAssignments(web: WebSession, courseId: number) {
  const rows = await readOverview(web, courseId, ['assign']);
  const assignments = [...rows].map(([cmid, row]) => {
    const due = Number(row.values.duedate);
    return {
      id: cmid,
      cmid,
      course: courseId,
      name: row.values.name || row.text.name || '',
      duedate: Number.isSafeInteger(due) && due > 0 ? due : 0,
    };
  });
  return { id: courseId, assignments };
}

async function getAssignments(web: WebSession, params: Params, hint: CallHint) {
  const courseIds = (Array.isArray(params.courseids) ? params.courseids : []).filter(isId);
  if (hint.cmid) return { courses: await oneAssignment(web, hint.cmid, courseIds), warnings: [] };
  const courses = await Promise.all(courseIds.map((id) => courseAssignments(web, id)));
  return { courses, warnings: [] };
}

// ------------------------------------------------------------------ mod_assign_get_submission_status

function lastAttempt(view: AssignView) {
  const s = view.status;
  if (!s) return undefined;
  return {
    submission: { status: s.status, timemodified: s.timemodified, plugins: s.plugins },
    submissiongroupmemberswhoneedtosubmit: [],
    locked: view.locked,
    canedit: view.canEdit,
    cansubmit: view.canSubmit,
    gradingstatus: s.gradingstatus,
    extensionduedate: s.extensionduedate,
  };
}

function feedbackOf(view: AssignView) {
  const f = view.feedback;
  if (!f) return undefined;
  const shown = text(f.gradefordisplay ?? '');
  const grade = /^(-?\d+(?:\.\d+)?)\s*\//.exec(shown)?.[1];
  return {
    gradefordisplay: f.gradefordisplay ?? '',
    gradeddate: f.gradeddate,
    ...(grade ? { grade: { grade, timemodified: f.gradeddate } } : {}),
    plugins: f.plugins,
  };
}

async function getSubmissionStatus(web: WebSession, params: Params) {
  const cmid = idParam(params.assignid);
  assertOwnUser(web, params.userid);
  const view = parseAssignView((await web.page(viewPath(cmid))).html, null);
  return {
    lastattempt: lastAttempt(view),
    feedback: feedbackOf(view),
    assignmentdata: { attachments: { intro: view.introFiles, activity: view.activityFiles } },
    warnings: [],
  };
}

// ------------------------------------------------------------------ writes

const warning = (cmid: number, warningcode: string, message: string): Warning[] => [
  { item: 'assignment', itemid: cmid, warningcode, message },
];

/** POSTs a form once: a redirect is Moodle's "saved"; a re-rendered page carries the reasons it was not. */
async function postForm(web: WebSession, cmid: number, form: AssignForm, code: string): Promise<Warning[]> {
  form.fields.set('submitbutton', form.submitLabel ?? '1');
  const res = await web.page(form.action, { method: 'POST', form: new URLSearchParams([...form.fields]) });
  if (res.status >= 300 && res.status < 400) return [];
  const errors = formErrors(res.html);
  return warning(cmid, code, errors.length ? errors.join(' ') : 'Moodle did not accept the form.');
}

function setEditor(fields: Map<string, string>, editor: unknown): void {
  if (!isRec(editor) || typeof editor.text !== 'string') return;
  fields.set('onlinetext_editor[text]', editor.text);
  fields.set('onlinetext_editor[format]', String(typeof editor.format === 'number' ? editor.format : 1));
  // the form's own [itemid] stays: it is the draft area of the editor's embedded files
}

const STATEMENT_NEEDED = 'This assignment requires accepting the submission statement.';

/**
 * Ticks the form's submission statement when it has one; a warning (do not post) when the user did not accept it,
 * quoting the statement: it may appear only now (with drafts it is on the submit form), so the user has not seen it.
 */
function acceptStatement(form: AssignForm, cmid: number, accepted: unknown): Warning[] | null {
  if (form.statement === null) return null;
  if (accepted !== true) {
    const shown = text(form.statement).slice(0, 600);
    const quoted = shown ? ` The statement: "${shown}"` : '';
    return warning(cmid, 'submissionstatementrequired', `${STATEMENT_NEEDED}${quoted}`);
  }
  form.fields.set('submissionstatement', '1');
  return null;
}

async function saveSubmission(web: WebSession, params: Params): Promise<Warning[]> {
  const cmid = idParam(params.assignmentid);
  const html = await optionalPage(web, viewPath(cmid, 'editsubmission'));
  const form = html ? parseEditForm(html, web.baseUrl) : null;
  if (!form) return warning(cmid, 'couldnotsavesubmission', 'Moodle does not allow editing this submission now.');
  const refused = acceptStatement(form, cmid, params.acceptsubmissionstatement);
  if (refused) return refused;
  const data = isRec(params.plugindata) ? params.plugindata : {};
  setEditor(form.fields, data.onlinetext_editor);
  if (isId(data.files_filemanager)) form.fields.set('files_filemanager', String(data.files_filemanager));
  return postForm(web, cmid, form, 'couldnotsavesubmission');
}

async function submitForGrading(web: WebSession, params: Params): Promise<Warning[]> {
  const cmid = idParam(params.assignmentid);
  const html = await optionalPage(web, viewPath(cmid, 'submit'));
  const form = html ? parseSubmitForm(html, web.baseUrl) : null;
  if (!form) return warning(cmid, 'couldnotsubmitforgrading', 'Moodle does not allow submitting this now.');
  const refused = acceptStatement(form, cmid, params.acceptsubmissionstatement);
  return refused ?? postForm(web, cmid, form, 'couldnotsubmitforgrading');
}

export const assignFunctions: WebFunctions = {
  mod_assign_get_assignments: getAssignments,
  mod_assign_get_submission_status: getSubmissionStatus,
  mod_assign_save_submission: saveSubmission,
  mod_assign_submit_for_grading: submitForGrading,
};
