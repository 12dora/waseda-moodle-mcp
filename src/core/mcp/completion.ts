import type { ServiceContext } from '../context';
import { listCourses } from '../services/courses';
import type { Course } from '../types';
import { callScoped } from './tools/register';

const MAX_SUGGESTIONS = 50;

/** The courses the user attends (confirmed selection, or the automatic suggestion). */
export const scopeCourses = (ctx: ServiceContext): Promise<Course[]> => listCourses(callScoped(ctx), { scope: 'mine' });

const fold = (s: string) => s.normalize('NFKC').toLowerCase().trim();

/**
 * Course suggestions for a half-typed value: ids that start with it, or names that contain it. `labelled` appends the
 * course name ("300907 — Finance") for prompt arguments, which read the leading digits. A completion never fails.
 */
export async function completeCourseIds(ctx: ServiceContext, typed: string, labelled: boolean): Promise<string[]> {
  try {
    const q = fold(typed);
    const hits = (await scopeCourses(ctx)).filter((c) => !q || String(c.id).startsWith(q) || fold(c.name).includes(q));
    return hits.slice(0, MAX_SUGGESTIONS).map((c) => (labelled ? `${c.id} — ${c.name}` : String(c.id)));
  } catch {
    return [];
  }
}
