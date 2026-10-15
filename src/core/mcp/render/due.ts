import { deadlineMs, fmt, fmtDue } from '../../time';
import type { DueItem, DueKind, DueList } from '../../types';
import { clip, hardCap, MAX_TEXT_CHARS, oneLine, plural } from './common';

const JST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86_400_000;
/** Undated activities beyond this many are summarised; they mostly are trackerless material, not tasks. */
const MAX_NO_DEADLINE_LINES = 5;
/** Calendar items of courses outside the user's selection: shown last and briefly. */
const MAX_OTHER_COURSE_LINES = 5;

type DueGroup = 'Overdue' | 'Today' | 'Tomorrow' | 'Next 7 days' | 'Later' | 'No deadline' | 'Past deadline';
/** Order on screen. */
const DISPLAY_ORDER: DueGroup[] = [
  'Overdue',
  'Today',
  'Tomorrow',
  'Next 7 days',
  'Later',
  'No deadline',
  'Past deadline',
];
/** Order in which groups claim the character budget: what is nearest wins over old or distant items. */
const BUDGET_ORDER: DueGroup[] = [
  'Today',
  'Tomorrow',
  'Overdue',
  'Next 7 days',
  'Later',
  'No deadline',
  'Past deadline',
];

const jstDay = (ms: number) => Math.floor((ms + JST_OFFSET_MS) / DAY_MS);

function dayGroup(diff: number): DueGroup {
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return diff <= 7 ? 'Next 7 days' : 'Later';
}

/** The instant the line shows: a deadline at 00:00 counts as the day before; opening times are plain. */
function shownMs(item: DueItem): number | null {
  if (item.dueAt) return deadlineMs(item.dueAt);
  return item.opensAt ? Date.parse(item.opensAt) : null;
}

function dueGroup(item: DueItem, now: number): DueGroup {
  const ms = shownMs(item);
  if (isSubmitted(item)) {
    if (item.dueAt && ms !== null && ms < now) return 'Past deadline'; // handed in, deadline gone: struck, last
  } else if (item.overdue) return 'Overdue';
  if (!item.dueAt && !item.notOpenYet) return 'No deadline'; // already open, nothing to hand in by a date
  return ms === null ? 'Later' : dayGroup(jstDay(ms) - jstDay(now));
}

function dueWhen(i: DueItem): string {
  if (!i.dueAt && i.source === 'activity' && !i.notOpenYet) return 'no deadline set in Moodle';
  if (i.dueAt) return `due ${fmtDue(i.dueAt)}${i.notOpenYet && i.opensAt ? `, opens ${fmt(i.opensAt)}` : ''}`;
  if (!i.opensAt) return 'no deadline';
  return i.notOpenYet ? `opens ${fmt(i.opensAt)}` : `open since ${fmt(i.opensAt)}, no deadline`;
}

const FORUM_DISCUSSION_URL = /\/mod\/(?:hsu)?forum\/discuss\.php/;

/** A deadline found in an announcement: its link is the news thread, not the task's own activity. */
const isAnnouncement = (i: DueItem) => i.source === 'text' && FORUM_DISCUSSION_URL.test(i.sourceUrl ?? '');

/**
 * Text items carry the quoted snippet and where it was found, so the model can check the date itself.
 * Announcement items say so and give the discussion link (they have no cmid of their own).
 */
function evidenceLine(i: DueItem): string {
  if (!i.evidence && i.source !== 'text') return '';
  const quote = i.evidence ? ` «${oneLine(i.evidence, 160)}»` : '';
  const where = i.sourceUrl ? ` ${i.sourceUrl}` : '';
  if (isAnnouncement(i)) {
    const evidence = quote ? `\n  evidence:${quote}` : '';
    return `\n  source: announcement${where}${evidence}`;
  }
  return quote || where ? `\n  evidence:${quote}${where}` : '';
}

const isSubmitted = (i: DueItem) => i.submission?.status === 'submitted';

const SUBMISSION_TAGS: Partial<Record<NonNullable<DueItem['submission']>['status'], string>> = {
  draft: 'draft saved — not submitted',
  'in-progress': 'attempt in progress — not submitted',
  reopened: 'reopened for resubmission',
};

/** Progress the user still has to act on; submitted items use the struck mark; "none" needs no tag. */
function submissionTag(i: DueItem): string {
  const text = i.submission ? SUBMISSION_TAGS[i.submission.status] : undefined;
  return text ? ` [${text}]` : '';
}

/** The id get_activity needs; announcement items have none (their link is printed under the line). */
const cmidTag = (i: DueItem) => (i.cmid !== null ? ` (cmid ${i.cmid})` : '');

/** What "can continue" means once handed in: an assignment stays editable, a quiz or survey takes another go. */
const againNote = (i: DueItem) => (i.kind === 'assign' ? ' (can still edit)' : ' (can answer again)');

function submittedMark(i: DueItem): string {
  const name = `~~${oneLine(i.name, 90)}~~ ✓ submitted`;
  const at = i.submission?.submittedAt;
  const again = i.submission?.canContinue ? againNote(i) : '';
  return `${at ? `${name} ${fmt(at)}` : name}${again}`;
}

function itemLabel(i: DueItem): string {
  return isSubmitted(i) ? submittedMark(i) : oneLine(i.name, 90);
}

/** One markdown bullet; submitted names are struck through, with course and cmid outside the strike. */
export function dueLine(i: DueItem): string {
  const late = i.overdue && !isSubmitted(i) ? ' — OVERDUE' : '';
  const fresh = i.isNew ? ' — NEW' : '';
  const verify = i.source === 'text' || i.evidence ? ' — mentioned in course text — verify' : '';
  const head = `- [${i.kind}] ${itemLabel(i)} — ${oneLine(i.courseName, 60)} — ${dueWhen(i)}`;
  return `${head}${verify}${late}${fresh}${submissionTag(i)}${cmidTag(i)}${evidenceLine(i)}`;
}

/** Newest first: NEW ones, then the higher cmid (added later). Stable otherwise. */
function newestFirst(items: readonly DueItem[]): DueItem[] {
  const newness = (i: DueItem) => (i.isNew ? 1 : 0);
  return [...items].sort((a, b) => newness(b) - newness(a) || (b.cmid ?? 0) - (a.cmid ?? 0));
}

/** The items a group may list: the "No deadline" group shows only its newest few. */
function listable(group: DueGroup, items: DueItem[]): DueItem[] {
  return group === 'No deadline' ? newestFirst(items).slice(0, MAX_NO_DEADLINE_LINES) : items;
}

interface Section {
  heading: string;
  lines: string[];
  dropped: number;
  capped: number; // items not even offered to the budget (the "No deadline" cap)
}

/** Overdue-but-open items may use at most this share of what is left, so upcoming ones are never crowded out. */
const OVERDUE_SHARE = 0.5;

function emptySection(group: DueGroup, items: DueItem[]): Section {
  const offered = listable(group, items);
  return {
    heading: `## ${group} (${items.length})`,
    lines: [],
    dropped: 0,
    capped: items.length - offered.length,
  };
}

interface LineBudget {
  left: number;
  allowance: number;
}

/** Picks matching items that fit; a too-long line is skipped so a later shorter one may still show. */
function takeDueItems(items: readonly DueItem[], want: (item: DueItem) => boolean, budget: LineBudget): DueItem[] {
  const keep: DueItem[] = [];
  for (const item of items) {
    if (!want(item)) continue;
    const cost = dueLine(item).length + 1;
    if (cost > budget.allowance) continue;
    keep.push(item);
    budget.allowance -= cost;
    budget.left -= cost;
  }
  return keep;
}

function groupAllowance(group: DueGroup, left: number): number {
  return group === 'Overdue' ? Math.floor(left * OVERDUE_SHARE) : left;
}

/** Open lines first in BUDGET_ORDER (overdue share unchanged); submitted lines take what remains. */
function fitSections(groups: Map<DueGroup, DueItem[]>, budget: number): Map<DueGroup, Section> {
  const out = new Map<DueGroup, Section>();
  const kept = new Map<DueGroup, DueItem[]>();
  const offeredOf = (g: DueGroup) => listable(g, groups.get(g) ?? []);
  let left = budget;
  for (const g of BUDGET_ORDER) {
    const items = groups.get(g) ?? [];
    if (items.length === 0) continue;
    const section = emptySection(g, items);
    const headingCost = section.heading.length + 2;
    const open = { left: left - headingCost, allowance: groupAllowance(g, left) - headingCost };
    kept.set(
      g,
      takeDueItems(offeredOf(g), (i) => !isSubmitted(i), open),
    );
    left = open.left;
    out.set(g, section);
  }
  for (const g of BUDGET_ORDER) {
    const section = out.get(g);
    if (!section) continue;
    const done = { left, allowance: left };
    const shown = new Set([...takeDueItems(offeredOf(g), isSubmitted, done), ...(kept.get(g) ?? [])]);
    const offered = offeredOf(g);
    section.lines = offered.filter((i) => shown.has(i)).map(dueLine);
    section.dropped = offered.length - section.lines.length;
    left = done.left;
  }
  return out;
}

function closedSummary(closed: DueItem[]): string {
  const names = closed.map((i) => `${oneLine(i.name, 40)} (${oneLine(i.courseName, 30)})`).join(', ');
  return clip(`${plural(closed.length, 'closed item')} no longer accepted: ${names}`, 400);
}

/** Calendar items of enrolled courses outside the scope that are still open: upcoming ones first, then overdue. */
function otherCourseItems(list: DueList): DueItem[] {
  const open = list.otherCourses.filter((i) => !i.closed && !isSubmitted(i));
  return [...open.filter((i) => !i.overdue), ...open.filter((i) => i.overdue)];
}

function dueFooter(list: DueList): string[] {
  const { scope, sweep } = list;
  const otherCount = otherCourseItems(list).length;
  const lines = [
    scope.mode === 'auto'
      ? `Using suggested courses (${scope.courseIds.length}); not confirmed by the user yet. Ask which courses they attend, then confirm with set_my_courses.`
      : `Your courses: ${scope.courseIds.length}.`,
  ];
  if (sweep.checked > 0 || sweep.stale > 0) {
    const stale =
      sweep.stale > 0 ? `, ${plural(sweep.stale, 'course')} not refreshed yet (course-page tasks may be missing)` : '';
    const at = sweep.checkedAt ? `, last check ${fmt(sweep.checkedAt)}` : '';
    lines.push(`Course pages checked: ${sweep.checked}${stale}${at}.`);
  }
  if (otherCount > 0) {
    lines.push(
      `${plural(otherCount, 'calendar deadline')} in enrolled courses outside your selection ${otherCount === 1 ? 'is' : 'are'} listed under "Other enrolled courses"; if one of those courses matters, add it with set_my_courses.`,
    );
  }
  if (scope.otherCount > 0) {
    lines.push(
      `${plural(scope.otherCount, 'other enrolled course')} not included (pass course_id to look at one; list_courses with scope "all" shows them).`,
    );
  }
  return lines;
}

/** Final group: calendar items of enrolled courses outside the scope (never dropped, but at most a few lines). */
function otherCoursesSection(list: DueList): string[] {
  const items = otherCourseItems(list);
  if (items.length === 0) return [];
  const shown = items.slice(0, MAX_OTHER_COURSE_LINES).map(dueLine);
  const more = items.length - shown.length;
  return ['', `## Other enrolled courses (${items.length})`, ...shown, ...(more > 0 ? [`… ${more} more`] : [])];
}

/** How the list was asked for and where it is read: the filters are echoed, console pointers only exist hosted. */
export interface DueView {
  stdio?: boolean;
  kinds?: readonly DueKind[];
  includeSubmitted?: boolean;
}

function filterNote({ kinds, includeSubmitted }: DueView): string[] {
  const parts: string[] = [];
  if (kinds && kinds.length > 0) parts.push(`only kinds: ${kinds.join(', ')}`);
  if (includeSubmitted === false) parts.push('submitted items hidden');
  return parts.length > 0 ? [`Filtered: ${parts.join('; ')}.`] : [];
}

/** Undated items beyond the cap are only in structuredContent when there is no console to browse them. */
function undatedMore(n: number, view: DueView): string {
  const where = view.stdio
    ? 'pass course_id to narrow; all are in structuredContent'
    : "see the console's Assignments & deadlines page";
  return `… ${n} more without a deadline (${where})`;
}

function sectionLines(sections: Map<DueGroup, Section>, view: DueView): string[] {
  const body: string[] = [];
  for (const g of DISPLAY_ORDER) {
    const s = sections.get(g);
    if (!s) continue;
    body.push('', s.heading, ...s.lines);
    if (s.dropped > 0) body.push(`… ${s.dropped} more (use course_id, kinds or a smaller days_ahead)`);
    if (s.capped > 0) body.push(undatedMore(s.capped, view));
  }
  return body;
}

function outstandingLine(list: DueList, outstanding: number, window: string): string {
  if (outstanding > 0) return `${plural(outstanding, 'item')} between ${window}:`;
  const where = otherCourseItems(list).length > 0 ? 'in your courses ' : '';
  return `Nothing outstanding ${where}between ${window}.`;
}

/** Head, other-courses block and footer shared by the date and course renderers. */
export function dueLayout(list: DueList, view: DueView) {
  const submitted = list.items.filter(isSubmitted).length;
  const outstanding = list.items.length - submitted;
  const window = `${list.windowFrom.slice(0, 10)} and ${list.windowTo.slice(0, 10)}`;
  const closed = list.items.filter((i) => i.closed && !isSubmitted(i));
  const notes: string[] = [];
  if (list.truncated) notes.push('(More events exist than could be loaded; narrow with course_id or days_ahead.)');
  notes.push(...dueFooter(list));
  return {
    head: [
      'Assignments & deadlines. Times are JST; a deadline at 00:00 is shown as the previous day 24:00.',
      ...filterNote(view),
      outstandingLine(list, outstanding, window),
    ],
    other: otherCoursesSection(list),
    notes,
    tail: closed.length > 0 ? [closedSummary(closed)] : [],
  };
}

export function renderDueList(list: DueList, view: DueView = {}): string {
  const layout = dueLayout(list, view);
  const listed = list.items.filter((i) => !i.closed || isSubmitted(i));
  const now = Date.parse(list.generatedAt);
  const groups = new Map<DueGroup, DueItem[]>();
  for (const item of listed) {
    const g = dueGroup(item, now);
    groups.set(g, [...(groups.get(g) ?? []), item]);
  }
  const reserved = [...layout.head, ...layout.notes, ...layout.tail, ...layout.other].join('\n').length + 160;
  const sections = fitSections(groups, MAX_TEXT_CHARS - reserved);
  const body = sectionLines(sections, view);
  return hardCap([...layout.head, ...body, ...layout.other, ...layout.notes, ...layout.tail].join('\n'));
}
