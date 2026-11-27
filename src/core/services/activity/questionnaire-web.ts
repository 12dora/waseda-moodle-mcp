/**
 * Reading a questionnaire on the web channel (one page each): the index `view.php`, the form `complete.php` (page 1;
 * `&resume=1` continues the saved draft), the latest submitted response (the user's responses page `myreport.php`
 * shows it read-only: the answers in words, no choice ids).
 * Later form pages cannot be opened without saving page 1 (Moodle moves on only by "next"), so a multi-page form is
 * read from its printable blank copy (`print.php?…&rid=0`, linked from the form), which heads every page with its
 * marker; a saved draft's answers on the later pages are not shown there.
 */

import type { MoodleApi } from '../../context';
import { MoodleError } from '../../errors';
import type { QuestionnaireQuestion } from '../../types';
import {
  parseWebQuestionnaireIndex,
  parseWebQuestionnairePage,
  parseWebQuestionnaireResponse,
  type WebFormPage,
} from '../submission/questionnaire-web';
import type { FormRead, QuestionnaireReader } from './questionnaire';
import { webSessionOf } from './web';

/** The form's first page; `resume` continues the user's saved draft. */
export const questionnaireFormPath = (cmid: number, resume: boolean): string =>
  `/mod/questionnaire/complete.php?id=${cmid}${resume ? '&resume=1' : ''}`;

const html = async (api: MoodleApi, path: string): Promise<string> => (await webSessionOf(api).page(path)).html;

/** null when Moodle refuses the page: the rest of the detail is still worth showing. */
const optionalHtml = (api: MoodleApi, path: string): Promise<string | null> =>
  html(api, path).catch((e: unknown) => {
    if (e instanceof MoodleError) return null;
    throw e;
  });

async function review(api: MoodleApi, _cmid: number, index: { reviewPath: string | null }) {
  const report = index.reviewPath ? await optionalHtml(api, index.reviewPath) : null;
  return report ? parseWebQuestionnaireResponse(report) : [];
}

/** The questions after page 1, from the printable blank copy; null when it cannot be read or does not match. */
async function laterQuestions(
  api: MoodleApi,
  first: WebFormPage,
): Promise<{ questions: QuestionnaireQuestion[]; unsupported: string[] } | null> {
  const printed = first.printPath ? await optionalHtml(api, first.printPath) : null;
  if (!printed) return null;
  const all = parseWebQuestionnairePage(printed, api.baseUrl);
  const onFirst = new Set(first.questions.map((q) => q.question.id));
  const ids = new Set(all.questions.map((q) => q.question.id));
  if (![...onFirst].every((id) => ids.has(id))) return null;
  const later = all.questions.filter((q) => !onFirst.has(q.question.id));
  if (!later.length) return null;
  const unsupported = all.unsupported.filter((u) => later.some((q) => u.endsWith(`(question_id ${q.question.id})`)));
  // a copy without page markers still puts them after page 1
  return { questions: later.map((q) => ({ ...q.question, page: Math.max(q.question.page, 2) })), unsupported };
}

async function form(api: MoodleApi, cmid: number, index: { draft: boolean }): Promise<FormRead> {
  const first = parseWebQuestionnairePage(await html(api, questionnaireFormPath(cmid, index.draft)), api.baseUrl);
  const read: FormRead = {
    questions: first.questions.map((q) => q.question),
    answers: index.draft ? 'draft' : null,
    complete: false,
    rid: first.rid,
    submitIds: first.ids,
    pages: 1,
    unsupported: first.unsupported,
    canDraft: first.buttons.resume !== undefined,
  };
  // Moodle shows its index (with the reason) instead of a form it does not offer
  if (!first.action || !first.questions.length) return { ...read, questions: [], refused: { notice: first.notice } };
  if (first.buttons.next === undefined) return { ...read, complete: first.buttons.submit !== undefined };
  const later = await laterQuestions(api, first);
  if (!later) return read;
  return {
    ...read,
    questions: [...read.questions, ...later.questions],
    complete: true,
    pages: Math.max(...later.questions.map((q) => q.page)),
    unsupported: [...first.unsupported, ...later.unsupported],
  };
}

export const webReader: QuestionnaireReader = {
  index: async (api, cmid) =>
    parseWebQuestionnaireIndex(await html(api, `/mod/questionnaire/view.php?id=${cmid}`), api.baseUrl),
  review,
  form,
};
