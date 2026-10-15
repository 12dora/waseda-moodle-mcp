import * as z from 'zod';
import { getSyllabusDetails } from '../../services/syllabus-details';
import { renderSyllabus, SYLLABUS_FOCUS } from '../render/syllabus';
import { syllabusOut } from '../schemas/syllabus';
import { defineTool, id, READ_HINTS } from './define';

const getSyllabusTool = defineTool({
  name: 'get_syllabus',
  title: 'Course syllabus',
  description:
    "Shows the public Waseda syllabus of one of the user's classes: overview, goals, before/after-class study, the session-by-session plan, " +
    'textbooks, references, the grading method (each part with its weight % and criteria), notes, language, format, instructors, term/period and room. ' +
    'Use it for "how am I graded", "what is covered in week N", "what should I study for the exam" or "what textbook". ' +
    'The result is a short digest; pass focus (plan, grading, overview or materials) for the full text of one part. ' +
    'Courses without a per-class page (e.g. 総合日本語 sections) get the public syllabus search link instead. ' +
    'The syllabus is the plan written before the term and can change once classes start.',
  annotations: READ_HINTS,
  input: z.object({
    course_id: id('Course id from list_courses.'),
    focus: z
      .enum(SYLLABUS_FOCUS)
      .describe('Print one part in full: overview (outline, goals, study), plan, grading or materials (books, notes).')
      .optional(),
  }),
  output: syllabusOut,
  async run(ctx, a) {
    const r = await getSyllabusDetails(ctx, a.course_id);
    return { text: renderSyllabus(r, a.focus), data: r };
  },
});

export const syllabusTools = [getSyllabusTool];
