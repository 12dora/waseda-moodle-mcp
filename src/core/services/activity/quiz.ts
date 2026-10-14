/** Quiz detail: settings, the user's attempts and best grade (read only). */

import type { MoodleApi } from '../../context';
import { MoodleError, NotFound } from '../../errors';
import { decodeEntities, htmlToMarkdown } from '../../html';
import { fromTs, nowSec } from '../../time';
import type { QuizAttempt, QuizDetail } from '../../types';
import { type ActivityInfo, type CourseModuleInfo, pickLang } from '../shared';

export interface RawQuiz {
  id: number;
  coursemodule: number;
  course: number;
  name: string;
  intro?: string | null;
  timeopen?: number | null;
  timeclose?: number | null;
  timelimit?: number | null;
  attempts?: number | null;
  grade?: number | null; // maximum grade
  sumgrades?: number | null; // maximum raw marks
  decimalpoints?: number | null;
  reviewmarks?: number | null; // review-option bit mask
}

export interface RawQuizAttempt {
  attempt: number;
  state: string;
  timestart?: number | null;
  timefinish?: number | null;
  sumgrades?: number | null;
  preview?: number | boolean | null;
}

export interface RawBestGrade {
  hasgrade?: boolean | null;
  grade?: number | null;
}

type AttemptList = { attempts?: RawQuizAttempt[] | null };

const fmtNum = (n: number, dp: number) => String(Number(n.toFixed(dp)));

/** Review phase bits of `reviewmarks`: during 0x10000, right after 0x1000, later while open 0x100, after close 0x10. */
function marksVisible(quiz: RawQuiz, a: RawQuizAttempt, now: number): boolean {
  const mask = quiz.reviewmarks;
  if (typeof mask !== 'number') return true;
  const finish = a.timefinish ?? 0;
  const close = quiz.timeclose ?? 0;
  if (a.state !== 'finished') return (mask & 0x10000) !== 0;
  if (now < finish + 120) return (mask & 0x1000) !== 0;
  if (!close || now < close) return (mask & 0x100) !== 0;
  return (mask & 0x10) !== 0;
}

function attemptGrade(quiz: RawQuiz, a: RawQuizAttempt, now: number): string | null {
  const total = quiz.sumgrades ?? 0;
  if (a.state !== 'finished' || typeof a.sumgrades !== 'number' || total <= 0) return null;
  if (!marksVisible(quiz, a, now)) return null;
  const dp = Math.min(4, Math.max(0, quiz.decimalpoints ?? 2));
  const max = quiz.grade ?? 0;
  return `${fmtNum((a.sumgrades / total) * max, dp)} / ${fmtNum(max, dp)}`;
}

export function mapQuiz(
  raw: RawQuiz,
  attempts: RawQuizAttempt[],
  best: RawBestGrade | null,
  info: ActivityInfo & { courseId: number; now?: number },
): QuizDetail {
  const now = info.now ?? nowSec();
  const dp = Math.min(4, Math.max(0, raw.decimalpoints ?? 2));
  const mapped: QuizAttempt[] = attempts
    .filter((a) => !a.preview)
    .map((a) => ({
      attempt: a.attempt,
      state: a.state,
      startedAt: fromTs(a.timestart),
      finishedAt: fromTs(a.timefinish),
      grade: attemptGrade(raw, a, now),
    }))
    .sort((x, y) => x.attempt - y.attempt);
  return {
    type: 'quiz',
    cmid: raw.coursemodule,
    instanceId: raw.id,
    courseId: info.courseId,
    courseName: info.courseName,
    name: decodeEntities(raw.name),
    url: info.url,
    description: htmlToMarkdown(pickLang(raw.intro, info.lang), { maxChars: 6000 }),
    opensAt: fromTs(raw.timeopen),
    closesAt: fromTs(raw.timeclose),
    timeLimitMinutes: raw.timelimit ? Math.round(raw.timelimit / 60) : null,
    attemptsAllowed: raw.attempts ? raw.attempts : null,
    attempts: mapped,
    bestGrade:
      best?.hasgrade && typeof best.grade === 'number'
        ? `${fmtNum(best.grade, dp)} / ${fmtNum(raw.grade ?? 0, dp)}`
        : null,
  };
}

export async function loadQuiz(api: MoodleApi, cm: CourseModuleInfo, info: ActivityInfo): Promise<QuizDetail> {
  const res = await api.call<{ quizzes?: RawQuiz[] | null }>('mod_quiz_get_quizzes_by_courses', {
    courseids: [cm.courseId],
  });
  const raw = (res?.quizzes ?? []).find((q) => q.coursemodule === cm.cmid);
  if (!raw) throw new NotFound(`Quiz ${cm.cmid} was not found or is not visible.`);

  const params = { quizid: raw.id, status: 'all', includepreviews: false };
  const attemptsP = api.call<AttemptList>('mod_quiz_get_user_quiz_attempts', params).catch((e: unknown) => {
    if (!(e instanceof MoodleError)) throw e;
    return api.call<AttemptList>('mod_quiz_get_user_attempts', params); // before Moodle 5.0
  });
  const bestP = api.call<RawBestGrade>('mod_quiz_get_user_best_grade', { quizid: raw.id }).catch((e: unknown) => {
    if (!(e instanceof MoodleError)) throw e;
    return null;
  });
  const [attempts, best] = await Promise.all([attemptsP, bestP]);
  return mapQuiz(raw, attempts?.attempts ?? [], best, { courseId: cm.courseId, ...info });
}
