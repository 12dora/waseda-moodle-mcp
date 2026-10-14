/** Text that differs between the hosted Worker and the local stdio server. */

import type { ServiceContext } from '../context';

type Mode = ServiceContext['mode'];

export const RECONNECT_STDIO =
  'The Moodle token has expired or was revoked. Ask the user to run "waseda-moodle-mcp connect" in a terminal (it explains how to get the link), then restart this MCP server.';

const FILES_WORKER =
  'Files are never inlined by default: get_file returns a short-lived download link; fetch it with your own tools (e.g. curl) and read the file locally.';
const FILES_STDIO =
  'Files are never inlined by default: get_file saves the file to a temporary local path (a file:// URL) that you can read directly.';

export function serverInstructions(mode: Mode): string {
  return [
    'Waseda Moodle (https://wsdmoodle.waseda.jp) for one student: deadlines, course content, grades, forums, messages and, with permission, submissions.',
    'All times are JST. A deadline at 00:00 is shown as the previous day 24:00 (the real deadline is the end of that day).',
    'For "what is due / what should I do" call get_due_items first; use get_activity (cmid) for requirements, files and submission status.',
    "Courses: only the user's own courses count by default. list_courses shows suggested ones; after the user confirms which they attend this term, call set_my_courses. get_course_updates shows what teachers added or changed lately; get_due_items also lists tasks found in course pages (verify those).",
    mode === 'stdio' ? FILES_STDIO : FILES_WORKER,
    'Every write is two-step: prepare_* returns a preview, show it to the user, and call confirm_action only after the user clearly agrees. Never submit, post or send on your own initiative.',
    'Never take quizzes for the user; only report quiz dates and results.',
  ].join('\n');
}

export function getFileDescription(mode: Mode): string {
  const how =
    mode === 'stdio'
      ? 'Downloads a Moodle file (slides, PDFs, assignment attachments, submitted files, forum attachments) to a temporary local file and returns its path as a file:// URL; read it with your own tools. Files over 50 MB are not downloaded; the result then carries the Moodle address for the user to open in a browser. '
      : 'Creates a short-lived download link for a Moodle file (slides, PDFs, assignment attachments, submitted files, forum attachments). Download the link with your own tools (e.g. curl) and read the file locally. ';
  return (
    how +
    'Pass the file url exactly as listed by get_activity or other tools. ' +
    'With inline=true, small files (up to 1 MiB) are also attached directly: text as text, common images as images, PDFs as binary content.'
  );
}
