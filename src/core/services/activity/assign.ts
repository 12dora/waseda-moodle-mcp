/** Assignment detail: settings from mod_assign_get_assignments, submission and feedback from the status call. */

import type { MoodleApi } from '../../context';
import { MoodleError, NotFound } from '../../errors';
import { decodeEntities, htmlToMarkdown } from '../../html';
import { fromTs } from '../../time';
import type { AssignDetail, Feedback, FileRef, SubmissionState } from '../../types';
import { type ActivityInfo, type CourseModuleInfo, mapFiles, pickLang, type RawFile } from '../shared';

const DESCRIPTION_MAX_CHARS = 20_000;

const md = (html: string | null | undefined, lang?: string | null, maxChars = DESCRIPTION_MAX_CHARS): string =>
  htmlToMarkdown(pickLang(html, lang), { maxChars });

interface RawAssignConfig {
  plugin: string;
  subtype: string;
  name: string;
  value: string;
}

export interface RawAssign {
  id: number;
  cmid: number;
  course: number;
  name: string;
  intro?: string | null;
  activity?: string | null;
  duedate?: number | null;
  allowsubmissionsfromdate?: number | null;
  cutoffdate?: number | null;
  submissiondrafts?: number | null;
  teamsubmission?: number | null;
  requiresubmissionstatement?: number | null;
  submissionstatement?: string | null;
  configs?: RawAssignConfig[] | null;
  introattachments?: RawFile[] | null;
  activityattachments?: RawFile[] | null;
}

interface RawAssignPlugin {
  type: string;
  fileareas?: Array<{ area?: string; files?: RawFile[] | null }> | null;
  editorfields?: Array<{ name?: string; text?: string | null; format?: number }> | null;
}

interface RawAssignSubmission {
  status?: string | null;
  timemodified?: number | null;
  plugins?: RawAssignPlugin[] | null;
}

export interface RawAssignStatus {
  lastattempt?: {
    submission?: RawAssignSubmission | null;
    teamsubmission?: RawAssignSubmission | null;
    canedit?: boolean | null;
    cansubmit?: boolean | null;
    locked?: boolean | null;
    gradingstatus?: string | null;
    extensionduedate?: number | null;
  } | null;
  feedback?: {
    gradefordisplay?: string | null;
    gradeddate?: number | null;
    plugins?: RawAssignPlugin[] | null;
  } | null;
  assignmentdata?: {
    attachments?: { intro?: RawFile[] | null; activity?: RawFile[] | null } | null;
  } | null;
}

// Mime groups Moodle accepts besides ".ext" tokens; group names with an underscore are recognised by the "_".
const FILE_TYPE_GROUPS = new Set([
  'archive',
  'audio',
  'document',
  'image',
  'presentation',
  'sourcecode',
  'spreadsheet',
  'text',
  'video',
]);

/** `filetypeslist` ("pdf;.docx, document") -> [".pdf", ".docx", "document"]. "*" or empty = any type. */
export function parseFileTypes(list: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of (list ?? '').split(/[\s,;]+/)) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (t === '*' || t === '.*') return [];
    const keep = t.startsWith('.') || t.includes('/') || t.includes('_') || FILE_TYPE_GROUPS.has(t);
    const norm = keep ? t : `.${t}`;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

const SUBMISSION_STATES = ['new', 'draft', 'submitted', 'reopened'] as const;

type Configs = RawAssignConfig[] | null | undefined;

function cfg(configs: Configs, plugin: string, name: string): string | undefined {
  return configs?.find((c) => c.subtype === 'assignsubmission' && c.plugin === plugin && c.name === name)?.value;
}

function cfgInt(configs: Configs, plugin: string, name: string): number | null {
  const v = cfg(configs, plugin, name);
  const n = v == null ? Number.NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function dedupeFiles(...lists: Array<RawFile[] | null | undefined>): FileRef[] {
  const seen = new Set<string>();
  return lists
    .flatMap((l) => mapFiles(l))
    .filter((f) => {
      if (seen.has(f.url)) return false;
      seen.add(f.url);
      return true;
    });
}

function areaFiles(plugins: RawAssignPlugin[] | null | undefined): FileRef[] {
  return mapFiles((plugins ?? []).flatMap((p) => (p.fileareas ?? []).flatMap((a) => a.files ?? [])));
}

function currentSubmission(status: RawAssignStatus | null, team: boolean): RawAssignSubmission | null {
  const last = status?.lastattempt;
  return (team ? last?.teamsubmission : null) ?? last?.submission ?? null;
}

function mapSubmission(status: RawAssignStatus | null, team: boolean, lang?: string | null): SubmissionState {
  const last = status?.lastattempt;
  const sub = currentSubmission(status, team);
  const st = sub?.status;
  const text = sub?.plugins
    ?.find((p) => p.type === 'onlinetext')
    ?.editorfields?.find((f) => f.name === 'onlinetext')?.text;
  return {
    status: SUBMISSION_STATES.find((x) => x === st) ?? 'none',
    gradingStatus: last?.gradingstatus ?? null,
    lastModified: st === 'new' ? null : fromTs(sub?.timemodified),
    onlineText: (text ? md(text, lang) : '') || null,
    files: areaFiles(sub?.plugins?.filter((p) => p.type === 'file')),
    canEdit: last?.canedit === true,
    canSubmit: last?.cansubmit === true,
    locked: last?.locked === true,
    extensionDue: fromTs(last?.extensionduedate),
  };
}

function mapFeedback(fb: RawAssignStatus['feedback'], lang?: string | null): Feedback | null {
  if (!fb) return null;
  const gradeText = md(fb.gradefordisplay, lang, 200);
  const grade = gradeText && gradeText !== '-' ? gradeText : null;
  const comments =
    (fb.plugins ?? [])
      .flatMap((p) => p.editorfields ?? [])
      .map((f) => (f.text ? md(f.text, lang) : ''))
      .filter(Boolean)
      .join('\n\n') || null;
  const files = areaFiles(fb.plugins);
  if (!grade && !comments && files.length === 0) return null;
  return { grade, gradedAt: fromTs(fb.gradeddate), comments, files };
}

/** Types from the settings plus the plugins the status shows: Waseda's `configs` can miss the file plugin. */
function submissionTypes(configs: Configs, sub: RawAssignSubmission | null): AssignDetail['submissionTypes'] {
  const shown = new Set(sub?.plugins?.map((p) => p.type));
  const types: AssignDetail['submissionTypes'] = [];
  for (const t of ['onlinetext', 'file'] as const) {
    if (cfg(configs, t, 'enabled') === '1' || shown.has(t)) types.push(t);
  }
  return types;
}

/** Limits come from the settings only; null = unknown (the settings may not list the plugin). */
function mapLimits(configs: Configs, types: AssignDetail['submissionTypes']) {
  const file = types.includes('file');
  // the word limit has its own switch; without the switch a positive limit still counts
  const wordLimitOn = types.includes('onlinetext') && cfg(configs, 'onlinetext', 'wordlimitenabled') !== '0';
  return {
    maxFiles: file ? cfgInt(configs, 'file', 'maxfilesubmissions') : null,
    maxFileBytes: file ? cfgInt(configs, 'file', 'maxsubmissionsizebytes') : null,
    acceptedTypes: file ? parseFileTypes(cfg(configs, 'file', 'filetypeslist')) : [],
    wordLimit: wordLimitOn ? cfgInt(configs, 'onlinetext', 'wordlimit') : null,
  };
}

export function mapAssign(
  raw: RawAssign,
  status: RawAssignStatus | null,
  info: ActivityInfo & { courseId: number },
): AssignDetail {
  const lang = info.lang;
  const team = raw.teamsubmission === 1;
  const types = submissionTypes(raw.configs, currentSubmission(status, team));
  const att = status?.assignmentdata?.attachments;
  return {
    type: 'assign',
    cmid: raw.cmid,
    instanceId: raw.id,
    courseId: info.courseId,
    courseName: info.courseName,
    name: decodeEntities(raw.name),
    url: info.url,
    description: [md(raw.intro, lang), md(raw.activity, lang)].filter(Boolean).join('\n\n'),
    attachments: dedupeFiles(raw.introattachments, raw.activityattachments, att?.intro, att?.activity),
    opensAt: fromTs(raw.allowsubmissionsfromdate),
    dueAt: fromTs(raw.duedate),
    cutoffAt: fromTs(raw.cutoffdate),
    submissionTypes: types,
    ...mapLimits(raw.configs, types),
    draftsEnabled: raw.submissiondrafts === 1,
    requiresStatement: raw.requiresubmissionstatement === 1,
    statement: raw.requiresubmissionstatement === 1 ? md(raw.submissionstatement, lang) || null : null,
    teamSubmission: team,
    submission: mapSubmission(status, team, lang),
    feedback: mapFeedback(status?.feedback, lang),
  };
}

export async function loadAssign(api: MoodleApi, cm: CourseModuleInfo, info: ActivityInfo): Promise<AssignDetail> {
  const res = await api.call<{ courses?: Array<{ assignments?: RawAssign[] | null }> | null }>(
    'mod_assign_get_assignments',
    { courseids: [cm.courseId] },
  );
  const raw = (res?.courses ?? []).flatMap((c) => c.assignments ?? []).find((a) => a.cmid === cm.cmid);
  if (!raw) throw new NotFound(`Assignment ${cm.cmid} was not found or is not visible.`);
  // a status failure still leaves the settings readable
  const status = await api
    .call<RawAssignStatus>('mod_assign_get_submission_status', { assignid: raw.id })
    .catch((e: unknown) => {
      if (e instanceof MoodleError) return null;
      throw e;
    });
  return mapAssign(raw, status ?? null, { courseId: cm.courseId, ...info });
}
