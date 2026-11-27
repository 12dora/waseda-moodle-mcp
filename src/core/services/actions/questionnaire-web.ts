/**
 * Sending questionnaire answers on the web channel, like a browser: open the form (complete.php, `&resume=1` to
 * continue the saved draft), and on every page take the form's own fields (sesskey, `a`, `sid`, `rid`, `sec`, …),
 * replace the answer inputs of the page's questions with the prepared answers (translated from the shared field
 * names) and press `next`, then `submit` (or `resume`, which saves a draft) on the last page. Moodle answers a page
 * with the next one (or with the same one and its error), a finished response with its thank-you page (or a redirect
 * to it); that page and the index read afterwards confirm it. Every POST goes through the session's `page()` (the
 * write is seen there) and none is ever retried.
 */

import type { MoodleApi } from '../../context';
import { InvalidInput } from '../../errors';
import type { WebSession } from '../../moodle/web/types';
import { questionnaireFormPath } from '../activity/questionnaire-web';
import { pathOf, webSessionOf } from '../activity/web';
import {
  parseWebQuestionnaireIndex,
  parseWebQuestionnairePage,
  type WebFormPage,
} from '../submission/questionnaire-web';
import { pageFieldsFor } from '../submission/questionnaire-web-inputs';
import type { QuestionnairePayload, QuestionnaireSender, Shown } from './questionnaire';

type Press = 'next' | 'submit' | 'resume';

const MISSING_BUTTON: Record<Press, string> = {
  next: 'Moodle did not show the button for the next page; answer the questionnaire in Moodle.',
  submit: 'Moodle did not show the submit button; answer the questionnaire in Moodle.',
  resume: 'This questionnaire cannot be saved as a draft; submit it (final: true) or use Moodle.',
};

/** The request a browser sends for `page` with `button` pressed and the prepared answers in place. */
async function formBody(web: WebSession, page: WebFormPage, button: Press, answers: Array<[string, string]>) {
  const value = page.buttons[button];
  if (value === undefined) throw new InvalidInput(MISSING_BUTTON[button]);
  const replaced = new Set(page.questions.flatMap((q) => q.inputs.names));
  const form = new URLSearchParams();
  for (const [name, v] of page.fields) if (!replaced.has(name)) form.append(name, v);
  if (!page.fields.has('sesskey')) form.append('sesskey', await web.sesskey());
  for (const [name, v] of answers) form.append(name, v);
  form.append(button, value);
  return form;
}

interface PressOptions {
  button: Press;
  /** The last page: every prepared answer must have found its question by now. */
  last: boolean;
}

/**
 * Posts one page; answers the page Moodle shows next. Refuses before posting when the page has a question this
 * server does not answer, or (on the last page) when a prepared answer found no question on any page.
 */
async function press(api: MoodleApi, page: WebFormPage, remaining: Map<string, string>, opts: PressOptions) {
  const web = webSessionOf(api);
  if (page.unsupported.length) {
    const list = page.unsupported.join(', ');
    throw new InvalidInput(`Moodle shows questions this server cannot answer (${list}); answer it in Moodle.`);
  }
  if (!page.action) throw new InvalidInput(MISSING_BUTTON[opts.button]);
  const answers = page.questions.flatMap((q) => pageFieldsFor(q, remaining));
  if (opts.last && remaining.size > 0) {
    throw new InvalidInput('Moodle did not show every question the answers were prepared for; prepare again.');
  }
  const res = await web.page(page.action, { method: 'POST', form: await formBody(web, page, opts.button, answers) });
  // a redirect away from Moodle (the questionnaire's own "thank you" URL) is not followed: the index tells then
  const next = res.location ? pathOf(res.location, api.baseUrl) : null;
  const html = next?.startsWith('/') ? (await web.page(next)).html : res.html;
  return parseWebQuestionnairePage(html, api.baseUrl);
}

/** The page as the shared flow sees it; a page without `sec` counts on from the previous one. */
function shownOf(page: WebFormPage, previous: number): Shown {
  const number = page.action && page.questions.length ? (page.pageNumber ?? previous + 1) : null;
  return { page: number, last: page.buttons.next === undefined, rid: page.rid, notice: page.notice };
}

export function webSender(api: MoodleApi, p: QuestionnairePayload): QuestionnaireSender {
  const remaining = new Map(Object.values(p.fields).flatMap((fields) => Object.entries(fields)));
  let current: WebFormPage | null = null;
  const shown = (page: WebFormPage, previous: number): Shown => {
    current = page;
    return shownOf(page, previous);
  };
  const currentPage = (): WebFormPage => {
    if (!current) throw new InvalidInput('The questionnaire form is not open.');
    return current;
  };
  return {
    open: async () => {
      const html = (await webSessionOf(api).page(questionnaireFormPath(p.cmid, p.rid > 0))).html;
      return shown(parseWebQuestionnairePage(html, api.baseUrl), 0);
    },
    next: async (at) => {
      const page = await press(api, currentPage(), remaining, { button: 'next', last: false });
      return shown(page, at.page ?? 0);
    },
    finish: async () => {
      const button = p.final ? 'submit' : 'resume';
      const after = await press(api, currentPage(), remaining, { button, last: true });
      const { notice, thanked } = after;
      if (after.action && after.questions.length) return { index: null, notice, cleared: false };
      const view = await webSessionOf(api).page(`/mod/questionnaire/view.php?id=${p.cmid}`);
      return { index: parseWebQuestionnaireIndex(view.html, api.baseUrl), notice, cleared: false, thanked };
    },
  };
}
