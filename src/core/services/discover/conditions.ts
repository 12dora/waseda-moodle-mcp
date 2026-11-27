/**
 * What a course still asks of the student for an activity ("View", "Submit", ...): the completion details of the web
 * service (`completiondata.details[].rulevalue`), or on the web channel the completion dropdown of the course page
 * (`[data-region="completionrequirements"]`, one `role="listitem"` per condition; met ones carry `text-success`).
 * The texts are Moodle's own, in the session language.
 */

import { attr, findAll, findFirst, text } from '../../moodle/web/html';

export interface RawCondition {
  rulevalue?: { status?: number; description?: string } | null;
}

const HIDDEN_LABEL = /<span\b[^>]*class="[^"]*visually-hidden[^"]*"[^>]*>[^<]*<\/span>/gi;
/** Detail status 1 = met (COMPLETION_COMPLETE); anything else is still to do. */
const MET = 1;

/** Texts of the conditions not met yet, from web-service details (all of them when none is marked as open). */
export function openConditions(details: RawCondition[] | null | undefined): string[] {
  const rules = (details ?? []).flatMap((d) => {
    const description = text(d.rulevalue?.description ?? '');
    return description ? [{ description, met: d.rulevalue?.status === MET }] : [];
  });
  const open = rules.filter((r) => !r.met);
  return (open.length > 0 ? open : rules).map((r) => r.description);
}

/** The part of a course-page item before its first nested module or section (a subsection holds its own). */
function ownPart(outer: string): string {
  const from = outer.indexOf('>') + 1;
  const cuts = ['data-for="cmitem"', 'data-for="section"'].map((m) => outer.indexOf(m, from)).filter((i) => i >= 0);
  return cuts.length > 0 ? outer.slice(0, Math.min(...cuts)) : outer;
}

/** Open condition texts of one item's completion dropdown ([] when it has none). */
function dropdownConditions(own: string): string[] {
  const box = findFirst(own, { attr: 'data-region', value: 'completionrequirements' });
  if (!box) return [];
  return findAll(box.inner, { attr: 'role', value: 'listitem' })
    .filter((item) => !attr(item.attrs, 'class').split(/\s+/).includes('text-success'))
    .map((item) => text(item.inner.replace(HIDDEN_LABEL, ' ')))
    .filter((t) => t !== '');
}

/** cmid -> open condition texts of every module of a course page that shows a completion dropdown. */
export function pageConditions(html: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const el of findAll(html, { attr: 'data-for', value: 'cmitem' })) {
    const cmid = Number(attr(el.attrs, 'data-id'));
    if (!Number.isSafeInteger(cmid) || cmid <= 0 || out.has(cmid)) continue;
    const conditions = dropdownConditions(ownPart(el.outer));
    if (conditions.length > 0) out.set(cmid, conditions);
  }
  return out;
}
