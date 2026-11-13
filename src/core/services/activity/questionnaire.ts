/**
 * Questionnaire detail (read only): window, the user's progress and every question with the user's own answers.
 * One mobile-template call for the index, then one per question page (`respond`) or one for the latest response
 * (`review`); the templates are parsed in submission/questionnaire.ts.
 */

import type { MoodleApi } from '../../context';
import { MoodleError } from '../../errors';
import { decodeEntities, htmlToMarkdown } from '../../html';
import type { RawDate } from '../../moodle/raw-course';
import { fromTs, nowMs, toMs } from '../../time';
import type { IsoJst, QuestionnaireDetail } from '../../types';
import { type ActivityInfo, type CourseModuleInfo, pickLang } from '../shared';
import {
  parseQuestionnaireIndex,
  parseQuestionnairePage,
  type QuestionnaireIndex,
  questionnaireRequest,
} from '../submission/questionnaire';
import { fetchModuleRow } from './content';

/** Question pages read per call of get_activity (one Moodle call each). */
const MAX_PAGES = 8;

type View = Parameters<typeof questionnaireRequest>[2];
/** `refused`: a question page came back as Moodle's index (with its notice), so answering is not offered after all. */
type Questions = Pick<QuestionnaireDetail, 'questions' | 'answers' | 'complete'> & {
  refused?: { notice: string | null };
};

async function template(api: MoodleApi, cmid: number, view?: View): Promise<unknown> {
  const req = questionnaireRequest(cmid, api.moodleUserId, view);
  return api.call(req.fn, req.args);
}

/** null when Moodle refuses the page: the rest of the detail is still worth showing. */
async function optionalTemplate(api: MoodleApi, cmid: number, view: View): Promise<unknown> {
  return template(api, cmid, view).catch((e: unknown) => {
    if (e instanceof MoodleError) return null;
    throw e;
  });
}

function dateOf(dates: RawDate[] | null | undefined, ids: readonly string[]): IsoJst | null {
  return fromTs(dates?.find((d) => d.dataid && ids.includes(d.dataid))?.timestamp);
}

function windowOf(opensAt: IsoJst | null, closesAt: IsoJst | null, now: number): QuestionnaireDetail['window'] {
  if (opensAt && now < toMs(opensAt)) return 'not-open';
  return closesAt && now >= toMs(closesAt) ? 'closed' : 'open';
}

/** The latest response read back in full (all pages in one call). */
async function reviewed(api: MoodleApi, cmid: number, ids: readonly number[]): Promise<Questions | null> {
  const res = await optionalTemplate(api, cmid, { action: 'review', submissionid: Math.max(...ids) });
  const questions = res ? parseQuestionnairePage(res, 1).questions : [];
  return questions.length ? { questions, answers: 'submitted', complete: true } : null;
}

/** The form as Moodle takes it: the response id to continue (0 = new) and the ids its submit button carries. */
interface FormRead extends Questions {
  rid: number;
  submitIds: { questionnaireId: number; surveyId: number } | null;
  pages: number;
}

/**
 * The form page by page (read only), with the saved draft's answers when there is one. Only the requested page
 * counts: when Moodle refuses responding (closed meanwhile) it renders its index with the notice instead.
 */
async function form(api: MoodleApi, cmid: number, index: QuestionnaireIndex): Promise<FormRead> {
  const out: FormRead = {
    questions: [],
    answers: index.draft ? 'draft' : null,
    complete: false,
    rid: index.draftRid ?? 0,
    submitIds: null,
    pages: 0,
  };
  for (let page = 1; page <= MAX_PAGES; page++) {
    const view: View = { action: 'respond', pagenum: page, ...(index.draftRid ? { rid: index.draftRid } : {}) };
    const res = await optionalTemplate(api, cmid, view);
    if (!res) break;
    const parsed = parseQuestionnairePage(res, page);
    if (parsed.pageNumber !== page) return { ...out, refused: { notice: parsed.notice } };
    out.questions.push(...parsed.questions);
    out.pages = page;
    out.rid = parsed.rid ?? out.rid;
    out.submitIds = parsed.submitIds ?? out.submitIds;
    if (!parsed.hasNextPage) return { ...out, complete: true };
  }
  return out;
}

/** What the detail shows of a form read (the ids only answering needs stay out). */
const questionsOf = ({ rid: _rid, submitIds: _ids, pages: _pages, ...questions }: FormRead): Questions => questions;

/**
 * A submitted response is shown as answered (also when another response is allowed); otherwise the form while
 * Moodle offers it. Closed / not-yet-open questionnaires show no questions in the app either.
 */
async function readQuestions(api: MoodleApi, cmid: number, index: QuestionnaireIndex): Promise<Questions> {
  if (!index.draft && index.submissionIds.length > 0) {
    const done = await reviewed(api, cmid, index.submissionIds);
    if (done) return done;
  }
  if (index.canAnswer) return questionsOf(await form(api, cmid, index));
  return { questions: [], answers: null, complete: index.submissionIds.length === 0 };
}

function statusOf(index: QuestionnaireIndex): QuestionnaireDetail['status'] {
  if (index.draft) return 'draft';
  return index.submissionIds.length > 0 || index.state?.status === 'submitted' ? 'submitted' : 'none';
}

type Base = Omit<QuestionnaireDetail, 'questions' | 'answers' | 'complete'>;

/** The detail as the index shows it, unless a question page was refused. */
function detailOf(base: Base, { refused, ...questions }: Questions): QuestionnaireDetail {
  if (!refused) return { ...base, ...questions };
  return { ...base, ...questions, canAnswer: false, notice: refused.notice ?? base.notice };
}

async function readBase(
  api: MoodleApi,
  cm: CourseModuleInfo,
  info: ActivityInfo,
): Promise<{ base: Base; index: QuestionnaireIndex }> {
  const [row, indexRaw] = await Promise.all([fetchModuleRow(api, cm), template(api, cm.cmid)]);
  const index = parseQuestionnaireIndex(indexRaw);
  const opensAt = dateOf(row.dates, ['timeopen', 'opendate']);
  const closesAt = dateOf(row.dates, ['timeclose', 'closedate']);
  const base: Base = {
    type: 'questionnaire',
    cmid: cm.cmid,
    courseId: cm.courseId,
    courseName: info.courseName,
    name: decodeEntities(row.name ?? cm.name),
    url: info.url,
    description: htmlToMarkdown(pickLang(row.description, info.lang), { maxChars: 6000 }),
    opensAt,
    closesAt,
    window: windowOf(opensAt, closesAt, nowMs()),
    status: statusOf(index),
    submittedAt: index.state?.submittedAt ?? null,
    // the saved draft is listed with the submitted responses
    submissions: Math.max(0, index.submissionIds.length - (index.draft ? 1 : 0)),
    canAnswer: index.canAnswer,
    notice: index.notice,
  };
  return { base, index };
}

export async function loadQuestionnaire(
  api: MoodleApi,
  cm: CourseModuleInfo,
  info: ActivityInfo,
): Promise<QuestionnaireDetail> {
  const { base, index } = await readBase(api, cm, info);
  return detailOf(base, await readQuestions(api, cm.cmid, index));
}

/** For answering: the detail with the form as Moodle offers it now (`form` null when it cannot be answered). */
export async function loadQuestionnaireForm(
  api: MoodleApi,
  cm: CourseModuleInfo,
  info: ActivityInfo,
): Promise<{ detail: QuestionnaireDetail; form: FormRead | null }> {
  const { base, index } = await readBase(api, cm, info);
  if (!index.canAnswer) return { detail: { ...base, questions: [], answers: null, complete: true }, form: null };
  const read = await form(api, cm.cmid, index);
  const detail = detailOf(base, questionsOf(read));
  return { detail, form: detail.canAnswer ? read : null };
}
