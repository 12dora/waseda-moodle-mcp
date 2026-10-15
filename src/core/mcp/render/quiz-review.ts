import type { QuizReview, QuizReviewQuestion } from '../../services/quiz-review';
import { fmt } from '../../time';
import { assemble, clip, type Entry, oneLine } from './common';

const marks = (q: QuizReviewQuestion): string => {
  if (q.mark === null && q.maxMark === null) return '';
  return ` · ${q.mark ?? '?'} / ${q.maxMark ?? '?'}`;
};

const label = (q: QuizReviewQuestion): string => oneLine(q.status || q.state, 30);

/** Right answers get one compact line; everything else is shown in full so mistakes can be studied. */
function questionText(q: QuizReviewQuestion): string {
  const head = `Q${q.number} (${q.type || 'question'})`;
  if (q.state === 'gradedright') {
    const right = q.rightAnswer ? ` → ${oneLine(q.rightAnswer, 60)}` : ''; // answered right: the right answer is theirs
    return `${head} ✓ ${label(q)}${marks(q)} — ${oneLine(q.text, 90)}${right}`;
  }
  const lines = [`## ${head} — ${label(q)} [${q.state}]${marks(q)}`, clip(q.text, 500)];
  if (q.answer) lines.push('Your answer:', clip(q.answer, 400));
  if (q.rightAnswer) lines.push(`Right answer: ${clip(q.rightAnswer, 250)}`);
  if (q.feedback) lines.push(`Feedback: ${clip(q.feedback, 250)}`);
  return lines.join('\n');
}

function attemptLine(a: QuizReview['attempts'][number]): string {
  const grade = a.grade ? `, grade ${a.grade}` : '';
  return `#${a.attempt} finished ${fmt(a.finishedAt)}${grade}`;
}

export function renderQuizReview(r: QuizReview): string {
  const attempts = r.attempts.map(attemptLine).join('; ');
  const head = [
    `# ${oneLine(r.name, 100)} — quiz review (cmid ${r.cmid})`,
    `Course: ${oneLine(r.courseName, 80)} (course_id ${r.courseId})`,
    `Link: ${r.url}`,
    attempts ? clip(`Finished attempts: ${attempts}`, 500) : 'No finished attempts.',
  ];
  if (r.reviewedAttempt !== null) head.push(`Reviewing attempt #${r.reviewedAttempt} (pass attempt to pick another).`);
  const footer: string[] = [];
  if (r.note) footer.push(r.note);
  if (r.questions.length) footer.push('Review only: this server never starts or continues quiz attempts.');
  const entries: Entry[] = r.questions.map((q) => ({ text: questionText(q), item: true }));
  return assemble({ head, entries, footer, hint: 'the complete review is in structuredContent' });
}
