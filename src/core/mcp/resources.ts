import { type McpServer, type ReadResourceResult, ResourceTemplate } from '@modelcontextprotocol/server';
import type { ServiceContext } from '../context';
import { InvalidInput } from '../errors';
import { getCourseOutline } from '../services/courses';
import { getSyllabusDetails } from '../services/syllabus-details';
import { nowMs } from '../time';
import type { Course } from '../types';
import { completeCourseIds, scopeCourses } from './completion';
import { renderOutline } from './render/courses';
import { renderSyllabus } from './render/syllabus';
import { audit, callScoped, toToolError } from './tools/register';

const MIME = 'text/markdown';
const SCOPE_MEMO_MS = 5000;

interface Kind {
  key: 'course' | 'syllabus';
  title: string;
  description: string;
  /** Same text as the tool of that name. */
  read(ctx: ServiceContext, courseId: number): Promise<string>;
}

const KINDS: Kind[] = [
  {
    key: 'course',
    title: 'Course outline',
    description: 'Sections and activities of one course, as returned by the get_course tool.',
    read: async (ctx, id) => renderOutline(await getCourseOutline(ctx, id)),
  },
  {
    key: 'syllabus',
    title: 'Course syllabus',
    description: 'The public syllabus digest of one course, as returned by the get_syllabus tool.',
    read: async (ctx, id) => renderSyllabus(await getSyllabusDetails(ctx, id)),
  },
];

/** resources/list asks both templates in one request: resolve the course scope once for a few seconds. */
function sharedScope(ctx: ServiceContext): () => Promise<Course[]> {
  let hit: { at: number; courses: Promise<Course[]> } | null = null;
  return () => {
    const now = nowMs();
    if (!hit || now - hit.at > SCOPE_MEMO_MS) hit = { at: now, courses: scopeCourses(ctx) };
    return hit.courses;
  };
}

function courseIdOf(variables: Record<string, string | string[]>): number {
  const raw = variables.course_id;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined || !/^[1-9]\d*$/.test(text)) throw new InvalidInput('course_id must be a positive integer.');
  return Number(text);
}

/** Errors leave as the tool's own messages (user-safe WmmError text, reconnect hint). */
async function guarded<T>(ctx: ServiceContext, action: string, args: unknown, run: () => Promise<T>): Promise<T> {
  try {
    const out = await run();
    audit(ctx, action, args);
    return out;
  } catch (e) {
    audit(ctx, action, args, e);
    throw toToolError(ctx, e);
  }
}

function registerKind(server: McpServer, ctx: ServiceContext, kind: Kind, courses: () => Promise<Course[]>): void {
  const action = `resource:${kind.key}`;
  const template = new ResourceTemplate(`moodle://${kind.key}/{course_id}`, {
    list: () =>
      guarded(ctx, `${action}:list`, {}, async () => ({
        resources: (await courses()).map((c) => ({
          uri: `moodle://${kind.key}/${c.id}`,
          name: c.shortName || String(c.id),
          title: c.name,
          description: kind.description,
          mimeType: MIME,
        })),
      })),
    complete: { course_id: (typed) => completeCourseIds(ctx, typed, false) },
  });
  server.registerResource(
    kind.key,
    template,
    { title: kind.title, description: kind.description, mimeType: MIME },
    async (uri, variables): Promise<ReadResourceResult> => {
      const text = await guarded(ctx, action, variables, () => kind.read(callScoped(ctx), courseIdOf(variables)));
      return { contents: [{ uri: uri.href, mimeType: MIME, text }] };
    },
  );
}

/** `moodle://course/{course_id}` and `moodle://syllabus/{course_id}`, listed for the user's courses (read scope). */
export function registerResources(server: McpServer, ctx: ServiceContext): void {
  const courses = sharedScope(ctx);
  for (const kind of KINDS) registerKind(server, ctx, kind, courses);
}
