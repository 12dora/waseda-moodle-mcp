/**
 * The activity overview of a course (`course/overview.php?id=<course>&expand[]=<modname>…`, Moodle 5): one table per
 * activity type with MACHINE values per cell — `<tr data-mdl-overview-cmid>` rows, `<td data-mdl-overview-item=…
 * data-mdl-overview-value=…>` cells (dates as unix seconds, completion 0/1, grades as raw numbers). ONE page for
 * every requested type. Shared by the assign / quiz / due-status adapters.
 */

import { attr, findAll, text } from '../html';
import type { WebSession } from '../types';

interface OverviewRow {
  /** The activity type, from the row's link to its `/mod/<modname>/view.php` page; null when the row has none. */
  modname: string | null;
  /** `data-mdl-overview-value` per item (only cells that carry one; '' is a value: "none"). */
  values: Record<string, string>;
  /** Visible text per item. */
  text: Record<string, string>;
}

/**
 * The grade column is keyed by its localized header (Grade, 評点); it is also given as `grade`. Other items are
 * language-independent (name, duedate, completion, submissionstatus, responded, discussions, …).
 */
const GRADE_ITEMS = new Set(['grade', '評点']);

const MODNAME = /^[a-z][a-z0-9_]*$/;
const MOD_LINK = /\/mod\/([a-z][a-z0-9_]*)\/view\.php/;

function readRow(rowHtml: string): OverviewRow {
  const row: OverviewRow = { modname: MOD_LINK.exec(rowHtml)?.[1] ?? null, values: {}, text: {} };
  for (const td of findAll(rowHtml, { attr: 'data-mdl-overview-item' })) {
    const raw = attr(td.attrs, 'data-mdl-overview-item');
    if (!raw) continue;
    const keys = GRADE_ITEMS.has(raw.toLowerCase()) ? [raw, 'grade'] : [raw];
    const hasValue = /(?:^|\s)data-mdl-overview-value\s*=/i.test(td.attrs);
    for (const key of keys) {
      if (hasValue) row.values[key] = attr(td.attrs, 'data-mdl-overview-value');
      row.text[key] = text(td.inner);
    }
  }
  return row;
}

/** Rows by cmid of an overview page. */
function parseOverview(html: string): Map<number, OverviewRow> {
  const out = new Map<number, OverviewRow>();
  for (const tr of findAll(html, { attr: 'data-mdl-overview-cmid', tag: 'tr' })) {
    const cmid = Number(attr(tr.attrs, 'data-mdl-overview-cmid'));
    if (Number.isSafeInteger(cmid) && cmid > 0 && !out.has(cmid)) out.set(cmid, readRow(tr.inner));
  }
  return out;
}

/**
 * The overview rows of the given activity types of a course, by cmid (one page; the path is built from the sorted
 * types, so callers asking for the same set share the memoised page).
 */
export async function readOverview(
  web: WebSession,
  courseId: number,
  modnames: readonly string[],
): Promise<Map<number, OverviewRow>> {
  const types = [...new Set(modnames.filter((m) => MODNAME.test(m)))].sort();
  const expand = types.map((m) => `&expand[]=${m}`).join('');
  const page = await web.page(`/course/overview.php?id=${courseId}${expand}`);
  return parseOverview(page.html);
}
