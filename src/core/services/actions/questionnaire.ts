/**
 * Questionnaire answers: prepare (validate against the form as Moodle offers it now, preview every answer) and
 * execute through the Moodle app's own channel (`tool_mobile_get_content` / `mobile_view_activity`): `nextpage` saves a
 * page and returns the next one with the response id, `submit` saves the last page and commits. The plugin's
 * `mod_questionnaire_submit_questionnaire_response` web service drops every answer, so it is not used.
 *
 * Replacing a saved draft (PoetOS mod_questionnaire, questionnaire.class.php): `nextpage` / `previouspage` go through
 * existing_response_action(), which deletes the page's saved answers before inserting (L1180), but `submit` calls
 * response_insert() directly (save_mobile_data, L4455) and only adds rows. So a continued draft's last page is first
 * cleared with an empty `previouspage` (it never checks the format, L1169), then `submit` saves and checks it as usual.
 */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput, NeedsReconnect } from '../../errors';
import type { ActionPreview, QuestionnaireDetail, QuestionnaireQuestion } from '../../types';
import { loadQuestionnaireForm } from '../activity/questionnaire';
import { type ActivityInfo, courseNameMap, getCourseModule } from '../shared';
import { answerText, fieldKey, parseQuestionnaireIndex, parseQuestionnairePage } from '../submission/questionnaire';
import { type ActionOutcome, assertWriteAllowed, positiveInt, type Raw, savePreview, truncate } from './shared';

export interface QuestionnaireAnswerInput {
  questionId: number;
  choiceIds?: Array<string | number>;
  otherText?: string;
  text?: string;
  rating?: Array<{ rowId: string | number; value: string | number }>;
}

interface PrepareQuestionnaireInput {
  cmid: number;
  answers: QuestionnaireAnswerInput[];
  /** false = save as a draft the user submits in Moodle. Default true. */
  final?: boolean;
}

type Fields = Record<string, string>;

type QuestionnairePayload = {
  cmid: number;
  questionnaireId: number;
  surveyId: number;
  rid: number; // the saved draft being continued, 0 = new response
  final: boolean;
  pages: number;
  fields: Record<string, Fields>; // page -> response_* fields
  listedBefore: number; // responses on the index page before the write (the draft included)
  url: string;
};

const MAX_TEXT = 20_000;
const MAX_STEPS = 12;
const CHOICE_TYPES = new Set(['yesno', 'radio', 'checkbox', 'dropdown']);

const labelOf = (q: QuestionnaireQuestion) => `Q${q.number ?? q.id}`;
const bad = (q: QuestionnaireQuestion, why: string) => new InvalidInput(`${labelOf(q)} (question_id ${q.id}): ${why}`);

// ------------------------------------------------------------------ answers -> fields

function chosen(q: QuestionnaireQuestion, key: string, a: QuestionnaireAnswerInput): Fields {
  const ids = [...new Set((a.choiceIds ?? []).map(String))];
  if (ids.length === 0) throw bad(q, 'choose an option with choice_ids.');
  const unknown = ids.filter((id) => !q.choices.some((c) => c.id === id));
  if (unknown.length) {
    throw bad(q, `unknown choice id ${unknown.join(', ')}; valid ids: ${q.choices.map((c) => c.id).join(', ')}.`);
  }
  if (q.type !== 'checkbox' && ids.length > 1) throw bad(q, 'takes exactly one choice.');
  const fields: Fields =
    q.type === 'checkbox' ? Object.fromEntries(ids.map((id) => [`${key}_${id}`, '1'])) : { [key]: ids[0] ?? '' };
  for (const c of q.choices.filter((x) => x.otherText && ids.includes(x.id))) {
    const other = a.otherText?.trim();
    if (!other) throw bad(q, `the choice "${c.label}" needs other_text.`);
    // the plugin skips an "other" answer whose text PHP's empty() treats as empty (single::insert_response)
    if (other === '0') throw bad(q, 'Moodle discards the other_text "0"; write it in words (for example "zero").');
    fields[`${key}_o${c.id}`] = boundedText(q, other);
  }
  return fields;
}

function rated(q: QuestionnaireQuestion, key: string, a: QuestionnaireAnswerInput): Fields {
  const fields: Fields = {};
  for (const r of a.rating ?? []) {
    const row = q.choices.find((c) => c.id === String(r.rowId));
    if (!row) throw bad(q, `unknown row id ${r.rowId}; valid ids: ${q.choices.map((c) => c.id).join(', ')}.`);
    const value = String(r.value);
    const step = q.scale.find((s) => s.value === value || s.label === value);
    if (!step) throw bad(q, `"${value}" is not on the scale (${q.scale.map((s) => s.value).join(', ')}).`);
    fields[`${key}_${row.id}`] = step.value;
  }
  if (Object.keys(fields).length === 0) throw bad(q, 'rate the rows with rating.');
  // Moodle takes a rating question only with every row rated, also when the question is optional (rate::response_valid)
  if (Object.keys(fields).length < q.choices.length) throw bad(q, 'every row must be rated.');
  return fields;
}

function boundedText(q: QuestionnaireQuestion, text: string): string {
  if (text.length > MAX_TEXT) throw bad(q, `the text is too long (max ${MAX_TEXT} characters).`);
  return text;
}

function typed(q: QuestionnaireQuestion, key: string, a: QuestionnaireAnswerInput): Fields {
  const text = a.text?.trim() ?? '';
  if (!text) throw bad(q, 'give the answer as text.');
  if (q.type === 'numeric' || q.type === 'slider') {
    const n = Number(text);
    if (!Number.isFinite(n)) throw bad(q, 'the answer must be a number.');
    const r = q.range;
    if (r && (n < r.min || n > r.max || (n - r.min) % r.step !== 0)) {
      throw bad(q, `the answer must be ${r.min}–${r.max} in steps of ${r.step}.`);
    }
  }
  if (q.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw bad(q, 'give the date as YYYY-MM-DD.');
  return { [key]: boundedText(q, text) };
}

function fieldsFor(q: QuestionnaireQuestion, a: QuestionnaireAnswerInput): Fields {
  const key = fieldKey(q);
  if (!key) throw bad(q, 'this kind of question can only be answered in Moodle.');
  if (CHOICE_TYPES.has(q.type)) return chosen(q, key, a);
  return q.type === 'rate' ? rated(q, key, a) : typed(q, key, a);
}

/** Fields per question; every answer must name a question of the form, every required question must be answered. */
function mapAnswers(questions: QuestionnaireQuestion[], answers: QuestionnaireAnswerInput[]): Map<number, Fields> {
  const out = new Map<number, Fields>();
  for (const a of answers) {
    const q = questions.find((x) => x.id === a.questionId);
    if (!q) throw new InvalidInput(`question_id ${a.questionId} is not in this questionnaire (see get_activity).`);
    if (out.has(q.id)) throw bad(q, 'answered twice.');
    out.set(q.id, fieldsFor(q, a));
  }
  const missing = questions.filter((q) => q.required && !out.has(q.id));
  if (missing.length) {
    const list = missing.map((q) => `${labelOf(q)} (question_id ${q.id})`).join(', ');
    throw new InvalidInput(`Required questions are not answered: ${list}. Moodle requires them for drafts too.`);
  }
  return out;
}

// ------------------------------------------------------------------ prepare

function answerLine(q: QuestionnaireQuestion, fields: Fields | undefined): string {
  const prompt = truncate(q.prompt.replace(/\s+/g, ' ').trim(), 80);
  const answer = fields ? answerText(q, fields) : null;
  return `${labelOf(q)} ${prompt}: ${answer ?? '(no answer)'}`;
}

/** The questionnaire and its form, read fresh; refuses when Moodle does not offer every page for answering now. */
async function answerableForm(ctx: ServiceContext, api: MoodleApi, cmid: number) {
  const [cm, names] = await Promise.all([getCourseModule(api, cmid), courseNameMap(ctx)]);
  if (cm.modname !== 'questionnaire') throw new InvalidInput('This activity is not a questionnaire.');
  const url = `${api.baseUrl}/mod/questionnaire/view.php?id=${cmid}`;
  const courseName = names.get(cm.courseId) ?? `Course ${cm.courseId}`;
  const info: ActivityInfo = { courseName, url, lang: ctx.user.lang };
  const { detail, form } = await loadQuestionnaireForm(api, cm, info);
  if (!form) {
    throw new InvalidInput(`This questionnaire cannot be answered now${detail.notice ? `: ${detail.notice}` : '.'}`);
  }
  const { submitIds } = form;
  if (!form.complete || !submitIds) {
    throw new InvalidInput('Not every page of this questionnaire could be read; answer it in Moodle.');
  }
  return { detail, form: { ...form, submitIds }, url };
}

function warningsFor(detail: QuestionnaireDetail, final: boolean): string[] {
  const warnings: string[] = [];
  if (detail.status === 'draft') warnings.push('Replaces the answers of the saved draft.');
  if (final && detail.submissions > 0) warnings.push('A response was already submitted; this adds another one.');
  if (!final) warnings.push('Saved as a draft: it is not submitted until the user submits it in Moodle.');
  return warnings;
}

export async function prepareQuestionnaire(
  ctx: ServiceContext,
  input: PrepareQuestionnaireInput,
): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  const cmid = positiveInt(input.cmid, 'cmid');
  const final = input.final ?? true;
  if (typeof final !== 'boolean') throw new InvalidInput('final must be true or false.');
  if (!Array.isArray(input.answers) || input.answers.length === 0) throw new InvalidInput('Give at least one answer.');
  const { detail, form, url } = await answerableForm(ctx, await ctx.moodle(), cmid);
  const byQuestion = mapAnswers(form.questions, input.answers);
  const fields: Record<string, Fields> = {};
  for (const q of form.questions) fields[q.page] = { ...fields[q.page], ...byQuestion.get(q.id) };
  const payload: QuestionnairePayload = {
    cmid,
    ...form.submitIds,
    rid: form.rid,
    final,
    pages: form.pages,
    fields,
    listedBefore: detail.submissions + (detail.status === 'draft' ? 1 : 0),
    url,
  };
  return savePreview(ctx, {
    kind: 'questionnaire_submit',
    title: `${final ? 'Submit answers to' : 'Save draft answers to'} '${detail.name}'`,
    details: [
      `Questionnaire: ${detail.name} (${detail.courseName})`,
      ...form.questions.map((q) => answerLine(q, byQuestion.get(q.id))),
    ],
    warnings: warningsFor(detail, final),
    payload,
  });
}

// ------------------------------------------------------------------ execute

/** One page as the app sends it: the button's args plus the page's fields (all of them unless given). */
async function sendPage(api: MoodleApi, p: QuestionnairePayload, view: Record<string, number | string>, only?: Fields) {
  const page = Number(view.pagenum);
  const args = [
    ...Object.entries({ cmid: p.cmid, ...view }).map(([name, value]) => ({ name, value: String(value) })),
    ...Object.entries(only ?? p.fields[page] ?? {}).map(([name, value]) => ({ name, value })),
  ];
  const res = await api.call<unknown>('tool_mobile_get_content', {
    component: 'mod_questionnaire',
    method: 'mobile_view_activity',
    args,
  });
  return { res, form: parseQuestionnairePage(res, page) };
}

function notAccepted(page: number, notice: string | null, cleared = false): InvalidInput {
  const why = notice ? `: ${notice}` : '.';
  const saved = page > 1 ? ' The earlier pages are saved as a draft in Moodle.' : '';
  const lost = cleared ? ' The answers the draft had on this page were removed.' : '';
  return new InvalidInput(`Moodle did not accept page ${page}${why}${saved}${lost}`);
}

/** What this run has written: the response it works on and the last page Moodle saved. */
interface Progress {
  rid: number;
  saved: number;
}

/**
 * Saves the pages before the last one (`nextpage`, which replaces their saved answers) and clears the last page of a
 * continued draft; returns the last page. Moodle answers a save with the next page and the response id on its buttons.
 */
async function savePages(api: MoodleApi, p: QuestionnairePayload, progress: Progress): Promise<number> {
  let page = 1;
  for (let step = 0; page < p.pages; step++) {
    if (step >= MAX_STEPS) throw new InvalidInput('The questionnaire has too many pages to answer here.');
    const { form } = await sendPage(api, p, { rid: progress.rid, completeq: 1, action: 'nextpage', pagenum: page });
    if (form.pageNumber === null || form.pageNumber <= page) throw notAccepted(page, form.notice);
    progress.rid = form.rid || progress.rid;
    progress.saved = page;
    page = form.pageNumber;
  }
  if (p.rid) {
    const view = { rid: progress.rid, completeq: 1, action: 'previouspage', pagenum: page };
    const { form } = await sendPage(api, p, view, {});
    // Moodle shows the page before (or this one, on page 1); its index means it refused the save
    if (form.pageNumber === null) throw notAccepted(page, form.notice);
  }
  return page;
}

/**
 * The last page goes with `submit` (`submit=1` commits; `submit=0` keeps it a saved draft). Success is read from
 * the page Moodle returns: the index with one more response (or the draft's resume button), not the form again.
 */
async function submitPages(api: MoodleApi, p: QuestionnairePayload, progress: Progress): Promise<ActionOutcome> {
  const page = await savePages(api, p, progress);
  const view = {
    questionnaireid: p.questionnaireId,
    surveyid: p.surveyId,
    userid: api.moodleUserId,
    pagenum: page,
    completed: 0,
    rid: progress.rid,
    submit: p.final ? 1 : 0,
    action: 'submit',
  };
  const { res, form } = await sendPage(api, p, view);
  if (form.questions.length > 0) throw notAccepted(page, form.notice, p.rid > 0);
  const index = parseQuestionnaireIndex(res);
  // a new response adds a review link; a continued draft turns into a submitted one
  const listed = p.listedBefore + (p.rid ? 0 : 1);
  const done = p.final ? !index.draft && index.submissionIds.length >= listed : index.draft;
  if (!done) {
    const why = index.notice ? ` (${index.notice})` : '';
    throw new InvalidInput(`Moodle did not confirm the answers${why}. Check them in Moodle before trying again.`);
  }
  const message = p.final ? 'Answers submitted.' : 'Answers saved as a draft; submit them in Moodle.';
  return { message, url: p.url };
}

/**
 * A rejected token hands the action back for a retry, which is safe while it continues the draft it was prepared on
 * (every save replaces). A response this run created exists only here, so a retry would start another one: the
 * action ends instead, and a new prepare continues the saved draft.
 */
export async function executeQuestionnaire(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as QuestionnairePayload;
  const progress: Progress = { rid: p.rid, saved: 0 };
  try {
    return await submitPages(api, p, progress);
  } catch (e) {
    if (!(e instanceof NeedsReconnect) || progress.rid === p.rid) throw e;
    const saved = progress.saved > 1 ? `Pages 1–${progress.saved} are` : 'Page 1 is';
    throw new InvalidInput(
      `${e.message} ${saved} saved as a draft in Moodle; after reconnecting, prepare the answers again to continue it.`,
    );
  }
}
