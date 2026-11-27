/**
 * Questionnaire answers as fields: the names the plugin's mobile view reads (`response_{type}_{question}[_{choice}]`,
 * `_o{choice}` for an "other" text). Both channels speak them: the web-service channel sends them as they are, the web
 * channel reads a form page into them and translates them back to the page's own input names
 * (submission/questionnaire-web.ts). Prepared actions store answers in this form.
 */

import { htmlToMarkdown } from '../../html';
import type { QuestionnaireChoice, QuestionnaireQuestion, QuestionnaireQuestionType } from '../../types';

export type Values = ReadonlyMap<string, string>;

const TYPES: Record<number, QuestionnaireQuestionType> = {
  1: 'yesno',
  2: 'text',
  3: 'essay',
  4: 'radio',
  5: 'checkbox',
  6: 'dropdown',
  8: 'rate',
  9: 'date',
  10: 'numeric',
  11: 'slider',
};

/** The question type of a field's type id ('other' for one this server does not know). */
export const typeOfField = (typeId: string | undefined): QuestionnaireQuestionType => TYPES[Number(typeId)] ?? 'other';

const ticked = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v !== 'false';

/** A saved text answer as read back: Markdown, bounded. */
const readText = (value: string): string | null => htmlToMarkdown(value, { maxChars: 4000 }) || null;

/** The answer in plain words: choice labels (with the "other" text), rating rows, or the text through `text`. */
export function answerFrom(q: QuestionnaireQuestion, key: string, values: Values, text = readText): string | null {
  const withOther = (c: QuestionnaireChoice): string => {
    const text = c.otherText ? values.get(`${key}_o${c.id}`) : undefined;
    return text ? `${c.label.replace(/[:：]\s*$/, '')}: ${text}` : c.label;
  };
  const joined = (list: string[]): string | null => (list.length ? list.join('; ') : null);
  const own = values.get(key);
  switch (q.type) {
    case 'yesno':
    case 'radio':
    case 'dropdown': {
      const c = q.choices.find((x) => x.id === own);
      return c ? withOther(c) : null;
    }
    case 'checkbox':
      return joined(q.choices.filter((c) => ticked(values.get(`${key}_${c.id}`))).map(withOther));
    case 'rate':
      return joined(
        q.choices.flatMap((c) => {
          const v = values.get(`${key}_${c.id}`);
          return v ? [`${c.label}: ${q.scale.find((s) => s.value === v)?.label ?? v}`] : [];
        }),
      );
    default:
      return own ? text(own) : null;
  }
}

/** `response_{type}_{question}`: the field (prefix) the plugin reads for a question; null for unknown types. */
export function fieldKey(q: QuestionnaireQuestion): string | null {
  const typeId = Object.keys(TYPES).find((k) => TYPES[Number(k)] === q.type);
  return typeId ? `response_${typeId}_${q.id}` : null;
}

/** The answer that a set of fields gives a question, in plain words, with any text in full exactly as it is sent. */
export function answerText(q: QuestionnaireQuestion, fields: Readonly<Record<string, string>>): string | null {
  const key = fieldKey(q);
  return key ? answerFrom(q, key, new Map(Object.entries(fields)), (value) => value) : null;
}
