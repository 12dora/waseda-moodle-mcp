import type { SyllabusDetails, SyllabusStatus } from '../../services/syllabus-details';
import type { SyllabusPage } from '../../services/syllabus-page';
import { assemble, clip, type Entry, oneLine } from './common';

/** Which part get_syllabus prints in full; without one every part is printed as a short digest. */
export const SYLLABUS_FOCUS = ['overview', 'plan', 'grading', 'materials'] as const;
type SyllabusFocus = (typeof SYLLABUS_FOCUS)[number];

/** Characters kept per part: a digest of everything, or the focused part in full. */
const LIMITS = {
  compact: {
    outline: 450,
    objectives: 450,
    prepost: 250,
    plan: 600,
    session: 90,
    grading: 450,
    criteria: 150,
    textbooks: 250,
    references: 150,
    notes: 250,
  },
  full: {
    outline: 3000,
    objectives: 2500,
    prepost: 2000,
    plan: 3000,
    session: 500,
    grading: 2500,
    criteria: 600,
    textbooks: 2000,
    references: 1500,
    notes: 2000,
  },
};
type Limits = typeof LIMITS.compact;

interface View {
  page: SyllabusPage;
  lim: Limits;
  full: boolean; // keep line breaks of the text
}

const nonEmpty = <T>(v: T | null | undefined | ''): v is T => v !== null && v !== undefined && v !== '';

/** `Label: text` (compact: one line; full: the text on its own lines), nothing for an empty cell. */
function textEntry(label: string, text: string, max: number, full: boolean): Entry[] {
  if (!text) return [];
  return [{ text: full ? `${label}:\n${clip(text, max)}` : `${label}: ${oneLine(text, max)}`, item: true }];
}

// ------------------------------------------------------------------ parts

function gradingEntries({ page, lim, full }: View): Entry[] {
  if (page.grading.length === 0) return textEntry('Grading', page.gradingText, lim.grading, full);
  const rows = page.grading.map<Entry>((g) => {
    const share = g.weight === null ? '' : ` — ${g.weight}%`;
    const criteria = g.criteria ? ` — ${oneLine(g.criteria, lim.criteria)}` : '';
    return { text: `- ${g.method}${share}${criteria}`, item: true };
  });
  return [{ text: 'Grading (method — weight — criteria):' }, ...rows];
}

function planEntries({ page, lim, full }: View): Entry[] {
  if (page.sessions.length === 0) return textEntry('Plan', page.planText, lim.plan, full);
  const rows = page.sessions.map<Entry>((s) => {
    const text = oneLine([s.title, s.body].filter(Boolean).join(' — '), lim.session);
    return { text: `${s.no}. ${text}`, item: true };
  });
  return [{ text: `Plan (${page.sessions.length} sessions):` }, ...rows];
}

const overviewEntries = ({ page, lim, full }: View): Entry[] => [
  ...textEntry('Overview', page.outline, lim.outline, full),
  ...textEntry('Goals', page.objectives, lim.objectives, full),
  ...textEntry('Before/after class', page.prepost, lim.prepost, full),
];

const materialsEntries = ({ page, lim, full }: View): Entry[] => [
  ...textEntry('Textbooks', page.textbooks, lim.textbooks, full),
  ...textEntry('References', page.references, lim.references, full),
  ...textEntry('Notes', page.notes, lim.notes, full),
];

const PARTS: Record<SyllabusFocus, Array<(v: View) => Entry[]>> = {
  overview: [overviewEntries],
  plan: [planEntries],
  grading: [gradingEntries],
  materials: [materialsEntries],
};
/** The digest order: what an exam or assignment plan needs first. */
const DIGEST: Array<(v: View) => Entry[]> = [gradingEntries, planEntries, overviewEntries, materialsEntries];

// ------------------------------------------------------------------ head

const room = (p: SyllabusPage) => [p.classroom, p.campus].filter(nonEmpty).join(', ');

function metaLine(p: SyllabusPage): string {
  const facts: Array<[string, string | null]> = [
    ['Term/period', p.termDayPeriod],
    ['Room', room(p)],
    ['Instructors', p.instructors.join(', ')],
    ['Credits', p.credits],
    ['Language', p.language],
    ['Format', p.modality],
    ['Category', p.category],
  ];
  return facts
    .filter(([, v]) => nonEmpty(v))
    .map(([k, v]) => `${k}: ${oneLine(v, 80)}`)
    .join(' | ');
}

function head(d: SyllabusDetails, page: SyllabusPage): string[] {
  const updated = page.updatedAt ? `, updated ${page.updatedAt}` : '';
  const title = [page.title, page.subtitle].filter(nonEmpty).join(' — ');
  return [
    `Syllabus — ${d.courseName} (course_id ${d.courseId})${updated}`,
    ...(title ? [oneLine(title, 160)] : []),
    metaLine(page),
    ...(d.url ? [`Public page: ${d.url}`] : []),
  ].filter(nonEmpty);
}

// ------------------------------------------------------------------ result

const PROBLEM: Record<Exclude<SyllabusStatus, 'ok'>, string> = {
  'not-a-class': 'This is not a regular class course (no class idnumber), so it has no per-class syllabus.',
  'no-page':
    'The public syllabus has no per-class page for this course (e.g. 総合日本語 sections only have a shared master page).',
  unavailable: "Waseda's public syllabus site did not answer; it is tried again after about an hour.",
  disabled: 'Public syllabus lookup is switched off on this server and nothing is cached for this course.',
};

function renderProblem(d: SyllabusDetails, status: Exclude<SyllabusStatus, 'ok'>): string {
  return [
    `Syllabus — ${d.courseName} (course_id ${d.courseId})`,
    PROBLEM[status],
    ...(d.url ? [`Public page (may open if the site recovers): ${d.url}`] : []),
    `Public syllabus search (ask the user to look it up by course name): ${d.searchUrl}`,
  ].join('\n');
}

export function renderSyllabus(d: SyllabusDetails, focus?: SyllabusFocus): string {
  if (d.status !== 'ok' || !d.page) return renderProblem(d, d.status === 'ok' ? 'no-page' : d.status);
  const { page } = d;
  const lim = focus ? LIMITS.full : LIMITS.compact;
  const view: View = { page, lim, full: focus !== undefined };
  const entries = (focus ? PARTS[focus] : DIGEST).flatMap((part) => part(view));
  const footer = [
    ...(d.requestedLang !== page.lang ? ['English page not available; showing the Japanese one.'] : []),
    focus
      ? 'Other parts: focus=overview | plan | grading | materials.'
      : 'Digest only: call again with focus=plan, grading, overview or materials for the full text.',
  ];
  const hint = focus ? 'cut to fit; the full text is in structuredContent' : 'use focus=… for the full text';
  return assemble({ head: head(d, page), entries, footer, hint });
}
