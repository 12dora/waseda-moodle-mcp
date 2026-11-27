import { formatBytes } from '../../format';
import { type CourseDownload, DOWNLOAD_KINDS, type DownloadFile, type DownloadKind } from '../../services/downloads';
import { fmt } from '../../time';
import { hardCap, oneLine, plural } from './common';

/** The shell snippet carries one line per file; it must never be cut, so the cap is far above the chunk size. */
const TEXT_BUDGET = 24_000;

const KIND_WORDS: Record<DownloadKind, [string, string]> = {
  resource: ['resource', 'resources'],
  folder: ['folder', 'folders'],
  page: ['page', 'pages'],
  assign: ['assignment', 'assignments'],
};

const VIEWED_TAIL = 'counted as viewing them on Moodle (marked viewed, and done where completion is on viewing).';

/** POSIX shell single-quoting. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function viewedNote(viewed: CourseDownload['viewed']): string | null {
  const parts = DOWNLOAD_KINDS.flatMap((k) => {
    const n = viewed[k] ?? 0;
    const [one, many] = KIND_WORDS[k];
    return n > 0 ? [plural(n, one, many)] : [];
  });
  if (parts.length === 0) return null;
  return `Opening ${parts.join(' and ')} ${VIEWED_TAIL}`;
}

function scopeOf(r: CourseDownload): string {
  return r.section === null ? `Course ${r.courseId}` : `Course ${r.courseId}, section ${r.section}`;
}

function fileLine(f: DownloadFile): string {
  const size = f.size !== null ? ` (${formatBytes(f.size)})` : '';
  const zip = f.zip ? ' [folder as ZIP]' : '';
  return `- ${f.path}${size}${zip} — ${oneLine(f.activity, 80)} (cmid ${f.cmid})`;
}

function failureLines(r: CourseDownload): string[] {
  if (r.failures.length === 0) return [];
  return [
    'Not downloaded:',
    ...r.failures.map(
      (f) => `- ${oneLine(f.activity, 80)} (cmid ${f.cmid})${f.file ? `, ${f.file}` : ''}: ${oneLine(f.reason, 200)}`,
    ),
  ];
}

function continueLine(r: CourseDownload, stdio: boolean): string[] {
  if (r.nextCursor === null) return [];
  const left = plural(r.remaining, 'activity', 'activities');
  const again = `call download_course_files again with the same course_id, section and kinds, cursor ${r.nextCursor}`;
  if (!stdio || !r.directory) return [`${left} left: ${again}.`];
  return [`${left} left: ${again} and dest_dir ${shellQuote(r.directory)} to add them to the same folder.`];
}

/** One `curl` per file into `course-<id>/<section>/…` (directories created by curl). */
function shellSnippet(r: CourseDownload): string[] {
  const linked = r.files.filter((f) => f.url);
  if (linked.length === 0) return [];
  const root = `course-${r.courseId}`;
  return [
    'Download everything (POSIX shell; one directory per section):',
    '```sh',
    ...linked.map((f) => `curl -fL --create-dirs -o ${shellQuote(`${root}/${f.path}`)} ${shellQuote(f.url ?? '')}`),
    '```',
  ];
}

function headLine(r: CourseDownload): string {
  const activities = plural(r.activitiesRead, 'activity', 'activities');
  const what = `${scopeOf(r)}: ${plural(r.files.length, 'file')} from ${activities}`;
  if (!r.expiresAt) return `${what}.`;
  return `${what}. Links valid until ${fmt(r.expiresAt)} JST, single-user, do not share.`;
}

function zipNote(r: CourseDownload): string[] {
  if (!r.expiresAt || !r.files.some((f) => f.zip)) return [];
  return [
    'A folder ZIP link fails (404) when the teacher turned folder downloads off; then list its files with get_activity (cmid). Downloading a ZIP counts as viewing the folder.',
  ];
}

export function renderCourseDownloadLinks(r: CourseDownload): string {
  const lines = [headLine(r)];
  const viewed = viewedNote(r.viewed);
  if (viewed) lines.push(viewed);
  if (r.files.length > 0) lines.push('Files:', ...r.files.map(fileLine));
  lines.push(...zipNote(r), ...failureLines(r), ...continueLine(r, false), ...shellSnippet(r));
  return hardCap(lines.join('\n'), TEXT_BUDGET);
}

export function renderCourseDownloadLocal(r: CourseDownload): string {
  const saved = r.files.filter((f) => f.localPath);
  const big = r.files.filter((f) => !f.localPath);
  const where = r.directory ? ` to ${r.directory}` : '';
  const lines = [`${scopeOf(r)}: saved ${plural(saved.length, 'file')}${where}.`];
  const viewed = viewedNote(r.viewed);
  if (viewed) lines.push(viewed);
  if (saved.length > 0) lines.push('Saved (relative to that folder):', ...saved.map(fileLine));
  if (big.length > 0) {
    lines.push(
      'Too large to download automatically (over 50 MB): open these Moodle addresses in a browser where the user is signed in.',
      ...big.map((f) => `${fileLine(f)}: ${f.url ?? ''}`),
    );
  }
  lines.push(...failureLines(r), ...continueLine(r, true));
  return hardCap(lines.join('\n'), TEXT_BUDGET);
}
