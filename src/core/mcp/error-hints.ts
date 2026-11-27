/**
 * What the user does next after a failed call: ONE table from error class / Moodle errorcode to the next step.
 * Throw sites say what happened; `explainError` appends the step (tools/register toToolError for tool results,
 * actions/confirm for failed writes). Errors marked `ownStep` (errors.ts withOwnStep) already name a more specific
 * step and pass unchanged.
 */

import type { ServiceContext } from '../context';
import {
  BudgetExceeded,
  MailNeedsReconnect,
  MoodleError,
  MoodleUnavailable,
  NeedsReconnect,
  NotFound,
  RateLimited,
  type WmmError,
} from '../errors';
import { MOODLE_URL } from '../moodle/launch';
import { RECONNECT_STDIO } from './wording';

export interface HintTarget {
  mode: ServiceContext['mode'];
  publicUrl: string;
  /** The tool (or resource) that failed: picks where valid ids are listed again. */
  tool?: string;
}

type Kind =
  | 'noPermission'
  | 'notFound'
  | 'webOnly'
  | 'maintenance'
  | 'validation'
  | 'unreadable'
  | 'tooLarge'
  | 'exists';

/** Moodle errorcodes (web pages, ajax, the token REST service) -> kind. */
const KIND_BY_CODE: Readonly<Record<string, Kind>> = {
  nopermissions: 'noPermission',
  nopermissiontoaccess: 'noPermission',
  accessdenied: 'noPermission',
  requireloginerror: 'noPermission',
  notenrolled: 'noPermission',
  invalidrecord: 'notFound',
  invalidrecordunknown: 'notFound',
  invalidcoursemodule: 'notFound',
  invalidcourseid: 'notFound',
  invalidid: 'notFound',
  not_found: 'notFound',
  servicenotavailable: 'webOnly',
  sitemaintenance: 'maintenance',
  validation: 'validation',
  unexpectedpage: 'unreadable',
  unreadablepage: 'unreadable',
  invalidresponse: 'unreadable',
  fileoversized: 'tooLarge',
  maxbytes: 'tooLarge',
  fileexists: 'exists',
};

/** English "what happened" for Moodle errors whose text came in the session language (validation keeps Moodle's). */
const WHAT: Readonly<Partial<Record<Kind, string>>> = {
  noPermission: 'Moodle refused access to this.',
  notFound: 'Moodle could not find this.',
  webOnly: 'Moodle does not offer this through this connection.',
  maintenance: 'Waseda Moodle is under maintenance.',
};

/** Failing tool -> the tool that lists valid ids again. */
const RELIST: Readonly<Record<string, string>> = {
  get_course: 'list_courses',
  get_syllabus: 'list_courses',
  get_course_updates: 'list_courses',
  get_grades: 'list_courses',
  search_course_content: 'list_courses',
  search_forums: 'list_courses',
  set_course_schedule: 'list_courses',
  set_my_courses: 'list_courses',
  list_incomplete: 'list_courses',
  list_my_posts: 'list_courses',
  download_course_files: 'list_courses or get_course',
  get_activity: 'get_course',
  list_discussions: 'get_course',
  prepare_completion: 'get_course',
  get_file: 'get_activity',
  create_upload_link: 'get_activity',
  get_quiz_review: 'get_activity',
  prepare_submission: 'get_activity',
  prepare_questionnaire: 'get_activity',
  get_discussion: 'list_discussions',
  prepare_forum_subscription: 'list_discussions',
  prepare_forum_post: 'get_discussion',
  prepare_forum_post_change: 'get_discussion',
  get_conversation: 'list_messages',
  prepare_message: 'list_messages',
  prepare_mark_read: 'list_messages or list_notifications',
  prepare_calendar_event: 'list_calendar_events',
};

interface Key {
  noun: string;
  listed: string;
}
const ID: Key = { noun: 'id', listed: 'an id' };
/** Failing tool -> what it takes instead of an id (the not-found step names it). */
const KEY_OF: Readonly<Record<string, Key>> = {
  get_file: { noun: 'file URL', listed: 'a file URL' },
};

const ACTION_TOOLS = new Set(['confirm_action', 'cancel_action']);
const ACTION_STEP = 'Use the action_id from the prepare_* result, or prepare the action again.';
const MAIL_TOOLS = /^(?:search_mail|get_mail|prepare_mail_)/;
/** Text in the session language (ja), not English. */
const NON_ENGLISH = /[　-鿿＀-￯]/;

const linkOf = (e: WmmError): string => (e instanceof MoodleError && e.url) || `${MOODLE_URL}/`;

function notFoundStep(tool: string | undefined): string {
  if (tool && ACTION_TOOLS.has(tool)) return ACTION_STEP;
  // resources (moodle://course/{id}, moodle://syllabus/{id}) take course ids
  const relist = tool?.startsWith('resource:') ? 'list_courses' : tool && RELIST[tool];
  const key = (tool && KEY_OF[tool]) || ID;
  const how = relist ? `call ${relist} again and use ${key.listed} it lists` : 'look it up again';
  return `It may have been deleted, or the ${key.noun} is wrong: ${how}.`;
}

const MAINTENANCE_STEP = 'Try again after the maintenance ends.';

const STEPS: Readonly<Record<Kind, (e: WmmError, t: HintTarget) => string>> = {
  noPermission: (e) =>
    `The teacher may have hidden it, or the user is not enrolled in the course. Check it on Moodle: ${linkOf(e)}`,
  notFound: (_e, t) => notFoundStep(t.tool),
  webOnly: (e) => `Ask the user to do this on Moodle directly: ${linkOf(e)}`,
  maintenance: () => MAINTENANCE_STEP,
  validation: () => 'Correct it and prepare the action again.',
  unreadable: (e) => `Try again; if it keeps happening, check it on Moodle directly: ${linkOf(e)}`,
  tooLarge: () => 'Upload a smaller file (compress or split it).',
  exists: () => 'Rename the file and upload it again.',
};

function waitText(sec: number): string {
  return sec < 90 ? `${Math.max(1, Math.ceil(sec))} seconds` : `${Math.ceil(sec / 60)} minutes`;
}

/** Null when the message already names the page to reconnect on. */
function mailReconnectStep(e: MailNeedsReconnect, t: HintTarget): string | null {
  if (!t.publicUrl) return 'Ask the user to reconnect mail in the console (Settings → Mail), then try again.';
  const page = `${t.publicUrl}/settings/mail`;
  return e.message.includes(page) ? null : `Ask the user to reconnect mail at ${page}, then try again.`;
}

/** Null when the message already names the page to reconnect on. */
function reconnectStep(e: NeedsReconnect, t: HintTarget): string | null {
  if (e instanceof MailNeedsReconnect) return mailReconnectStep(e, t);
  const page = `${t.publicUrl}/connect`;
  if (e.message.includes(page)) return null;
  return (
    'Ask the user to sign in to Waseda Moodle in their browser: with the browser extension the connection then ' +
    `renews itself. Without it, reconnect at ${page} (paste the MoodleSession cookie). Then try again.`
  );
}

function unavailableStep(e: MoodleUnavailable): string {
  if (e.maintenance) return MAINTENANCE_STEP;
  return 'If it keeps happening, Waseda Moodle may be busy or under maintenance: try again in a few minutes.';
}

function budgetStep(t: HintTarget): string {
  if (t.tool && MAIL_TOOLS.test(t.tool)) return 'Narrow the search and try again.';
  return 'Narrow it (pass course_id, fewer days or a single forum) and try again.';
}

/** The step for errors of our own classes; null when the class has none. */
function classStep(e: WmmError, t: HintTarget): string | null {
  if (e instanceof NeedsReconnect) return reconnectStep(e, t);
  if (e instanceof MoodleUnavailable) return unavailableStep(e);
  if (e instanceof BudgetExceeded) return budgetStep(t);
  if (e instanceof RateLimited) {
    return `Wait ${e.retryAfterSec ? waitText(e.retryAfterSec) : 'a minute'} and try again.`;
  }
  if (e instanceof NotFound) return notFoundStep(t.tool);
  return null;
}

/** What happened (English) and the step for a Moodle errorcode. */
function moodleStep(e: MoodleError, t: HintTarget): { what: string; step: string } | null {
  const kind = KIND_BY_CODE[e.errorcode];
  if (!kind) return null;
  const replace = kind !== 'validation' && NON_ENGLISH.test(e.message);
  return { what: (replace && WHAT[kind]) || e.message, step: STEPS[kind](e, t) };
}

/** The user-facing message of `e`: what happened plus what to do next. */
export function explainError(e: WmmError, t: HintTarget): string {
  const stdio = t.mode === 'stdio' || !t.publicUrl;
  // the Moodle connect command; mail is reconnected in the console (reconnectStep)
  if (e instanceof NeedsReconnect && !(e instanceof MailNeedsReconnect) && stdio) return RECONNECT_STDIO;
  if (e.ownStep) return e.message;
  const moodle = e instanceof MoodleError ? moodleStep(e, t) : null;
  const what = moodle?.what ?? e.message;
  const step = moodle?.step ?? classStep(e, t);
  if (!step || what.includes(step)) return what;
  return `${what.trimEnd()} ${step}`;
}
