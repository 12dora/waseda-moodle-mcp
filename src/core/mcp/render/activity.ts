import { fmt } from '../../time';
import type { ActivityDetail, ContentDetail, ForumDetail, QuizDetail } from '../../types';
import { assignText } from './assign';
import { assemble, clip, fileLines, hardCap, MAX_TEXT_CHARS, oneLine } from './common';
import { discussionLine } from './forums';

function quizText(q: QuizDetail): string {
  const lines = [
    `# ${oneLine(q.name, 100)} — quiz (cmid ${q.cmid})`,
    `Course: ${oneLine(q.courseName, 80)} (course_id ${q.courseId})`,
    `Link: ${q.url}`,
    `Opens: ${fmt(q.opensAt)} · Closes: ${fmt(q.closesAt)}`,
    `Time limit: ${q.timeLimitMinutes ? `${q.timeLimitMinutes} min` : 'none'} · Attempts allowed: ${q.attemptsAllowed ?? 'unlimited'}`,
  ];
  if (q.attempts.length > 0) {
    lines.push('Attempts:');
    for (const t of q.attempts.slice(0, 10)) {
      const finished = t.finishedAt ? `, finished ${fmt(t.finishedAt)}` : '';
      lines.push(`- #${t.attempt} ${t.state}${finished}${t.grade ? `, grade ${t.grade}` : ''}`);
    }
  } else {
    lines.push('No attempts yet.');
  }
  if (q.bestGrade) lines.push(`Best grade: ${q.bestGrade}`);
  lines.push('The user must take quizzes themselves in Moodle; this server cannot attempt them.');
  const room = Math.max(400, MAX_TEXT_CHARS - lines.join('\n').length - 120);
  if (q.description.trim()) lines.push('', '## Description', clip(q.description, room));
  return hardCap(lines.join('\n'));
}

function forumText(f: ForumDetail): string {
  const head = [
    `# ${oneLine(f.name, 100)} — forum (cmid ${f.cmid}, forum_id ${f.forumId}, ${f.forumType})`,
    `Course: ${oneLine(f.courseName, 80)} (course_id ${f.courseId})`,
    `Link: ${f.url}`,
  ];
  if (f.dueAt) head.push(`Due: ${fmt(f.dueAt)}`);
  if (f.description.trim()) head.push(clip(f.description, 600));
  head.push(f.discussions.length ? 'Recent discussions:' : 'No discussions yet.');
  const entries = f.discussions.map((d) => ({ text: discussionLine(d), item: true }));
  return assemble({ head, entries, hint: 'use list_discussions with forum_cmid' });
}

function contentText(c: ContentDetail): string {
  const lines = [
    `# ${oneLine(c.name, 100)} — ${c.modname} (cmid ${c.cmid})`,
    `Course: ${oneLine(c.courseName, 80)} (course_id ${c.courseId})`,
    `Link: ${c.url}`,
  ];
  if (c.externalUrl) lines.push(`External link: ${c.externalUrl}`);
  if (c.files.length > 0) lines.push('Files (pass a url to get_file):', ...fileLines(c.files, 15));
  const room = Math.max(500, MAX_TEXT_CHARS - lines.join('\n').length - 160);
  const desc = c.description.trim();
  const body = c.body?.trim() ?? '';
  const descRoom = body ? Math.floor(room / 3) : room;
  if (desc) lines.push('', clip(desc, descRoom));
  if (body) lines.push('', clip(body, room - Math.min(desc.length, descRoom)));
  return hardCap(lines.join('\n'));
}

export function renderActivity(a: ActivityDetail): string {
  switch (a.type) {
    case 'assign':
      return assignText(a);
    case 'quiz':
      return quizText(a);
    case 'forum':
      return forumText(a);
    default:
      return contentText(a);
  }
}
