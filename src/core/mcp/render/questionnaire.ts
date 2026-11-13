import { fmt, fmtDue } from '../../time';
import type { QuestionnaireDetail, QuestionnaireQuestion, QuestionnaireQuestionType } from '../../types';
import { assemble, clip, type Entry, oneLine, plural } from './common';

const TYPE_LABEL: Record<QuestionnaireQuestionType, string> = {
  yesno: 'yes/no',
  text: 'short text',
  essay: 'essay',
  radio: 'single choice',
  checkbox: 'multiple choice',
  dropdown: 'dropdown',
  rate: 'rating scale',
  date: 'date',
  numeric: 'number',
  slider: 'slider',
  other: 'other',
};

const WINDOW_LABEL: Record<QuestionnaireDetail['window'], string> = {
  open: 'open',
  'not-open': 'not open yet',
  closed: 'closed',
};

function statusLine(q: QuestionnaireDetail): string {
  let status = 'not answered';
  if (q.status === 'draft') status = 'draft saved, not submitted';
  if (q.status === 'submitted') {
    const at = q.submittedAt ? ` ${fmt(q.submittedAt)}` : '';
    status = `answered${at}${q.submissions > 1 ? ` (${q.submissions} responses)` : ''}`;
  }
  const now = q.canAnswer ? 'can be answered now' : 'cannot be answered now';
  return `Status: ${status} · ${WINDOW_LABEL[q.window]} · ${now}`;
}

function questionText(q: QuestionnaireQuestion): string {
  const tags = [TYPE_LABEL[q.type], ...(q.required ? ['required'] : [])].join(', ');
  const lines = [`Q${q.number ?? '-'} [${tags}] (question_id ${q.id}) ${oneLine(q.prompt, 300)}`];
  for (const c of q.choices) lines.push(`  - ${c.id}: ${oneLine(c.label, 120)}${c.otherText ? ' (+ text)' : ''}`);
  if (q.scale.length) {
    const values = q.scale.map((s) => (s.label === s.value ? s.value : `${s.value} = ${s.label}`));
    lines.push(`  Scale: ${values.join(', ')}`);
  }
  if (q.range) lines.push(`  Range: ${q.range.min}–${q.range.max} (step ${q.range.step})`);
  if (q.answer) lines.push(`  Answer: ${oneLine(q.answer, 300)}`);
  return lines.join('\n');
}

function questionEntries(q: QuestionnaireDetail): Entry[] {
  const paged = new Set(q.questions.map((x) => x.page)).size > 1;
  const out: Entry[] = [];
  let page = 0;
  for (const x of q.questions) {
    if (paged && x.page !== page) out.push({ text: `Page ${x.page}:` });
    page = x.page;
    out.push({ text: questionText(x), item: true });
  }
  return out;
}

const ANSWERS_LABEL = { submitted: ', with the submitted answers', draft: ', with the saved draft' } as const;

function questionsHeading(q: QuestionnaireDetail): string {
  const required = q.questions.filter((x) => x.required).length;
  const whose = q.answers ? ANSWERS_LABEL[q.answers] : '';
  return `Questions (${plural(q.questions.length, 'question')}, ${required} required${whose}):`;
}

export function questionnaireText(q: QuestionnaireDetail): string {
  const head = [
    `# ${oneLine(q.name, 100)} — questionnaire (cmid ${q.cmid})`,
    `Course: ${oneLine(q.courseName, 80)} (course_id ${q.courseId})`,
    `Link: ${q.url}`,
    `Opens: ${fmt(q.opensAt)} · Closes: ${fmtDue(q.closesAt)}`,
    statusLine(q),
  ];
  if (q.notice) head.push(`Moodle: ${oneLine(q.notice, 300)}`);
  if (q.description.trim()) head.push(clip(q.description, 600));
  const footer: string[] = [];
  if (!q.complete) footer.push('Some question pages could not be read; the full questionnaire is in Moodle.');
  if (q.questions.length === 0 && !q.canAnswer) {
    footer.push('Moodle shows the questions only while the questionnaire can be answered.');
  }
  if (q.canAnswer && q.questions.length && q.complete) {
    footer.push('To answer: prepare_questionnaire with these ids, then confirm_action once the user agrees.');
  }
  if (q.questions.length) head.push('', questionsHeading(q));
  return assemble({ head, entries: questionEntries(q), footer, hint: 'all questions are in the structured result' });
}
