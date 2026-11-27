/**
 * Forum rows of the course activity overview (`/course/overview.php?id=<course>&expand[]=forum`, Moodle 5; also where
 * mod/forum/index.php redirects). Each `<tr data-mdl-overview-cmid>` carries the forum's real id on its tracking and
 * subscription toggles (`data-type="forum-track-toggle|forum-subscription-toggle" data-forumid`), the discussion
 * count (`data-mdl-overview-item="discussions"`) and the user's tracking / subscription state.
 */

import { attr, findAll, findFirst } from '../html';

export interface OverviewForum {
  cmid: number;
  forumId: number;
  name: string;
  numDiscussions: number | null;
  /** The tracking toggle is on (tracked forum, optional or forced). */
  tracked: boolean | null;
  /** mod_forum forcesubscribe: 1 forced (on, locked), 3 disabled (off, locked), 0 the user's choice. */
  forceSubscribe: number | null;
}

const FORCED = 1;
const DISALLOWED = 3;
const CHOICE = 0;

const isChecked = (attrs: string) => /(?:^|\s)checked(?:\s|=|$)/i.test(attrs);
const isDisabled = (attrs: string) => /(?:^|\s)disabled(?:\s|=|$)/i.test(attrs);

function toggle(row: string, type: string): string | null {
  const input = findAll(row, { attr: 'data-type', value: type, tag: 'input' })[0];
  return input ? input.attrs : null;
}

function itemValue(row: string, item: string): string | null {
  const cell = findFirst(row, { attr: 'data-mdl-overview-item', value: item });
  return cell ? attr(cell.attrs, 'data-mdl-overview-value') : null;
}

function subscriptionMode(attrs: string | null): number | null {
  if (attrs === null) return null;
  if (!isDisabled(attrs)) return CHOICE;
  return isChecked(attrs) ? FORCED : DISALLOWED;
}

function forumRow(tr: { attrs: string; outer: string }): OverviewForum | null {
  const cmid = Number(attr(tr.attrs, 'data-mdl-overview-cmid'));
  const track = toggle(tr.outer, 'forum-track-toggle');
  const subscribe = toggle(tr.outer, 'forum-subscription-toggle');
  const idSource = track ?? subscribe;
  const forumId = idSource ? Number(attr(idSource, 'data-forumid')) : Number.NaN;
  if (!Number.isSafeInteger(cmid) || cmid <= 0 || !Number.isSafeInteger(forumId) || forumId <= 0) return null;
  const count = Number.parseInt(itemValue(tr.outer, 'discussions') ?? '', 10);
  return {
    cmid,
    forumId,
    name: itemValue(tr.outer, 'name') ?? (idSource ? attr(idSource, 'data-forumname') : ''),
    numDiscussions: Number.isFinite(count) ? count : null,
    tracked: track === null ? null : isChecked(track),
    forceSubscribe: subscriptionMode(subscribe),
  };
}

/** The forum rows of an overview page (rows of other activity types have no forum toggles and are skipped). */
export function parseForumOverview(html: string): OverviewForum[] {
  const out: OverviewForum[] = [];
  for (const tr of findAll(html, { attr: 'data-mdl-overview-cmid', tag: 'tr' })) {
    const row = forumRow(tr);
    if (row) out.push(row);
  }
  return out;
}
