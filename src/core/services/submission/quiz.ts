/** Quiz progress from the user's attempts + "may I attempt again" from the access information. */

import { isObj } from '../../moodle/wire';
import { fromTs } from '../../time';
import type { DueSubmission } from '../../types';
import type { BatchRequest } from './batch';

export const quizAttemptsRequest = (quizId: number): BatchRequest => ({
  fn: 'mod_quiz_get_user_quiz_attempts',
  args: { quizid: quizId, status: 'all' },
});

export const quizAccessRequest = (quizId: number): BatchRequest => ({
  fn: 'mod_quiz_get_attempt_access_information',
  args: { quizid: quizId },
});

interface Attempt {
  number: number;
  state: string;
  finishedAt: number;
}

interface QuizInput {
  attempts: unknown;
  access: unknown;
  /** Total attempts the quiz allows, when known (only used for the note). */
  attemptsAllowed?: number | null;
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

function toAttempt(a: Record<string, unknown>): Attempt {
  return { number: num(a.attempt), state: typeof a.state === 'string' ? a.state : '', finishedAt: num(a.timefinish) };
}

/** Real attempts only (teacher previews dropped); null when the response is not an attempts list. */
function readAttempts(data: unknown): Attempt[] | null {
  if (!isObj(data) || !Array.isArray(data.attempts)) return null;
  const real = data.attempts.filter(isObj).filter((a) => a.preview !== 1 && a.preview !== true);
  return real.map(toAttempt);
}

/** `preventnewattemptreasons: []` means another attempt is allowed; unknown access information counts as "no". */
function mayAttemptAgain(access: unknown): boolean {
  const reasons = isObj(access) ? access.preventnewattemptreasons : null;
  return Array.isArray(reasons) && reasons.length === 0;
}

function attemptNote(n: number, allowed: number | null | undefined): string | null {
  if (n <= 0) return null;
  return allowed ? `attempt ${n} of ${allowed}` : `attempt ${n}`;
}

const isOpen = (a: Attempt) => a.state === 'inprogress' || a.state === 'overdue';

/** null when the attempts could not be read. */
export function parseQuizState(input: QuizInput): DueSubmission | null {
  const attempts = readAttempts(input.attempts);
  if (!attempts) return null;
  const open = attempts.find(isOpen);
  if (open) {
    return {
      status: 'in-progress',
      canContinue: true,
      submittedAt: null,
      graded: false,
      note: attemptNote(open.number, input.attemptsAllowed),
    };
  }
  const finished = attempts.filter((a) => a.state === 'finished');
  const last = finished.reduce<Attempt | null>((best, a) => (!best || a.number > best.number ? a : best), null);
  const finishedAt = Math.max(0, ...finished.map((a) => a.finishedAt));
  return {
    status: last ? 'submitted' : 'none',
    canContinue: mayAttemptAgain(input.access),
    submittedAt: last ? fromTs(finishedAt) : null,
    graded: false,
    note: last ? attemptNote(last.number, input.attemptsAllowed) : null,
  };
}
