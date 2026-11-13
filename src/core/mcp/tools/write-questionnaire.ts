import * as z from 'zod';
import { prepareQuestionnaire } from '../../services/actions';
import { renderActionPreview } from '../render/actions';
import { actionPreviewOut } from '../schemas/actions';
import { defineTool, id, PREPARE_HINTS } from './define';

const idValue = z.union([z.string().min(1), z.number()]);

const answer = z.object({
  question_id: id('question_id from get_activity.'),
  choice_ids: z
    .array(idValue)
    .max(100)
    .describe(
      'Choice ids: exactly one for single choice, dropdown and yes/no ("1" yes, "0" no); any for multiple choice.',
    )
    .optional(),
  other_text: z.string().max(2000).describe('Text for a chosen choice marked "(+ text)".').optional(),
  text: z
    .string()
    .describe('Answer of a text, essay, number, slider or date (YYYY-MM-DD) question, as the user wrote it.')
    .optional(),
  rating: z
    .array(z.object({ row_id: idValue, value: idValue }))
    .max(100)
    .describe('Rating-scale answers: one row id with one value of its scale per row.')
    .optional(),
});

export const prepareQuestionnaireTool = defineTool({
  name: 'prepare_questionnaire',
  title: 'Prepare questionnaire answers',
  description:
    'Step 1 of 2: checks answers to a questionnaire (アンケート) against its current questions (open window, required questions, choice ids, scales, numbers, dates) and returns a PREVIEW listing every answer; nothing is sent yet. ' +
    'Read the questions with get_activity first. Use only answers the user gave or approved, show the preview, and call confirm_action only after the user explicitly agrees. ' +
    'final=false saves the answers as a draft the user submits in Moodle; Moodle requires the required questions for drafts too.',
  annotations: PREPARE_HINTS,
  input: z.object({
    cmid: id('Questionnaire cmid.'),
    answers: z.array(answer).min(1).max(200).describe('One entry per answered question.'),
    final: z.boolean().describe('true (default) = submit; false = save as a draft.').optional(),
  }),
  output: actionPreviewOut,
  async run(ctx, a) {
    const r = await prepareQuestionnaire(ctx, {
      cmid: a.cmid,
      final: a.final,
      answers: a.answers.map((x) => ({
        questionId: x.question_id,
        choiceIds: x.choice_ids,
        otherText: x.other_text,
        text: x.text,
        rating: x.rating?.map((r) => ({ rowId: r.row_id, value: r.value })),
      })),
    });
    return { text: renderActionPreview(r), data: r };
  },
});
