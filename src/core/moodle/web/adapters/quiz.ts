/**
 * mod_quiz_* on the web channel. The quiz instance id is the cmid (surrogate, see the r14 emulation contract): every
 * `quizid` parameter is a cmid. Settings, attempts, best grade and access information all come from ONE page,
 * `mod/quiz/view.php?id=<cmid>` (GETs are memoised per session, so the four functions share it); the review from
 * `mod/quiz/review.php`. Never starts or continues an attempt.
 */

import type { CallHint } from '../../../context';
import { MoodleError } from '../../../errors';
import { pageConfig } from '../html';
import { readOverview } from '../parse/overview';
import { parseQuizView, parseReviewPage } from '../parse/quiz-page';
import type { WebFunctions, WebSession } from '../types';

/** All four review phases of reviewmarks (during, immediately after, later while open, after close). */
const MARKS_SHOWN = 0x10000 | 0x1000 | 0x100 | 0x10;

function idParam(params: Record<string, unknown>, name: string): number {
  const n = Number(params[name]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new MoodleError(`Invalid parameter ${name}.`, 'invalidparameter');
  return n;
}

async function readView(web: WebSession, cmid: number) {
  const page = await web.page(`/mod/quiz/view.php?id=${cmid}`);
  return parseQuizView(page.html, pageConfig(page.html).courseId);
}

type View = Awaited<ReturnType<typeof readView>>;

/** Marks are visible when an attempt shows numbers; hidden when finished attempts show none; unknown otherwise. */
function reviewMarks(view: View): number | undefined {
  if (view.attempts.some((a) => a.sumgrades !== null)) return MARKS_SHOWN;
  return view.attempts.some((a) => a.state === 'finished') ? 0 : undefined;
}

function quizFromView(cmid: number, view: View, fallbackCourse: number) {
  const graded = view.attempts.find((a) => a.maxGrade !== null);
  const grade = view.finalGrade?.max ?? graded?.maxGrade ?? null;
  const reviewmarks = reviewMarks(view);
  return {
    id: cmid,
    coursemodule: cmid,
    course: view.courseId ?? fallbackCourse,
    name: view.name,
    intro: view.intro,
    timeopen: view.timeopen ?? 0,
    timeclose: view.timeclose ?? 0,
    timelimit: view.timelimit,
    attempts: view.attemptsAllowed,
    grade,
    sumgrades: graded?.maxMarks ?? null,
    decimalpoints: view.finalGrade?.decimals ?? graded?.decimals ?? null,
    ...(view.grademethod === null ? {} : { grademethod: view.grademethod }),
    ...(reviewmarks === undefined ? {} : { reviewmarks }),
  };
}

const num = (v: string | undefined): number => {
  const n = Number(v);
  return v && Number.isFinite(n) ? n : 0;
};

/**
 * Without a cmid hint: the course's activity overview (one page per course) — id, name and close date only. The
 * overview's grade column is the USER's grade, not the quiz maximum, so `grade` stays null.
 */
async function quizzesOfCourse(web: WebSession, courseId: number) {
  const rows = await readOverview(web, courseId, ['quiz']);
  return [...rows].map(([cmid, row]) => ({
    id: cmid,
    coursemodule: cmid,
    course: courseId,
    name: row.values.name || row.text.name || '',
    timeclose: num(row.values.duedate),
    grade: null,
  }));
}

async function quizzesByCourses(web: WebSession, params: Record<string, unknown>, hint: CallHint) {
  const courseIds = Array.isArray(params.courseids) ? params.courseids.map(Number).filter(Number.isSafeInteger) : [];
  if (hint.cmid) {
    const view = await readView(web, hint.cmid);
    const quiz = quizFromView(hint.cmid, view, courseIds[0] ?? 0);
    const wanted = courseIds.length === 0 || courseIds.includes(quiz.course);
    return { quizzes: wanted ? [quiz] : [], warnings: [] };
  }
  const lists = await Promise.all(courseIds.map((id) => quizzesOfCourse(web, id)));
  return { quizzes: lists.flat(), warnings: [] };
}

const STATUS_FILTER: Readonly<Record<string, (state: string) => boolean>> = {
  finished: (s) => s === 'finished' || s === 'abandoned',
  unfinished: (s) => s === 'inprogress' || s === 'overdue',
};

async function userAttempts(web: WebSession, params: Record<string, unknown>) {
  const view = await readView(web, idParam(params, 'quizid'));
  const keep = STATUS_FILTER[String(params.status ?? 'finished')] ?? (() => true);
  const attempts = view.attempts
    .filter((a) => keep(a.state))
    .map((a) => ({
      id: a.id,
      attempt: a.attempt,
      state: a.state,
      timestart: a.timestart,
      timefinish: a.timefinish,
      sumgrades: a.sumgrades,
      preview: false,
    }));
  return { attempts, warnings: [] };
}

async function bestGrade(web: WebSession, params: Record<string, unknown>) {
  const view = await readView(web, idParam(params, 'quizid'));
  const final = view.finalGrade;
  return final ? { hasgrade: true, grade: final.grade, warnings: [] } : { hasgrade: false, warnings: [] };
}

const NO_NEW_ATTEMPT = 'No new attempt can be started on this quiz.';

async function accessInformation(web: WebSession, params: Record<string, unknown>) {
  const view = await readView(web, idParam(params, 'quizid'));
  if (view.canAttempt) return { preventnewattemptreasons: [], warnings: [] };
  return { preventnewattemptreasons: view.notices.length ? view.notices : [NO_NEW_ATTEMPT], warnings: [] };
}

async function attemptReview(web: WebSession, params: Record<string, unknown>) {
  const attemptId = idParam(params, 'attemptid');
  const page = Number(params.page ?? -1);
  const paging = Number.isInteger(page) && page >= 0 ? `&page=${page}&showall=0` : '&showall=1';
  const res = await web.page(`/mod/quiz/review.php?attempt=${attemptId}${paging}`);
  return { questions: parseReviewPage(res.html), warnings: [] };
}

export const quizFunctions: WebFunctions = {
  mod_quiz_get_quizzes_by_courses: quizzesByCourses,
  mod_quiz_get_user_quiz_attempts: userAttempts,
  mod_quiz_get_user_attempts: userAttempts,
  mod_quiz_get_user_best_grade: bestGrade,
  mod_quiz_get_attempt_access_information: accessInformation,
  mod_quiz_get_attempt_review: attemptReview,
};
