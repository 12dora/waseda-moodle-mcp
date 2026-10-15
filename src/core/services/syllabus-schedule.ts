/**
 * The meeting slots of one syllabus: the `学期曜日時限` day/period text (after the term) plus the `使用教室` and
 * `キャンパス` cells. Pure parsing; see r6-report §2 for the grammar:
 *   slot  := [index ":"] ( フルOD | 無その他 | 月１-２ | 月１・２ | 木夜６-７ | 火４時限 | Thur.6-7(evening) ) [(隔週)]
 *   cells := slot ( "／" | "<br>" | "、" | " 02:" ) slot ...
 * A part that is none of meeting / on-demand / その他 is not guessed at: `scheduleUnparsed` says the cell holds
 * something this parser does not know, so the caller can tell "unknown time" from "no fixed time".
 */

export interface SyllabusSlot {
  weekday: number; // Mon = 1 ... Sun = 7
  periodFrom: number;
  periodTo: number;
  night: boolean; // 夜 / (evening): periods 6-7 follow the night clock on weekdays
  classroom: string | null;
  campus: string | null;
}

export interface Schedule {
  slots: SyllabusSlot[];
  onDemand: boolean; // any フルOD / On demand part
  scheduleUnparsed: boolean; // some part is neither a meeting, on-demand nor 無その他 (the time is not known)
}

interface Part {
  index: number | null;
  body: string;
}

const DAYS: Record<string, number> = {
  月: 1,
  火: 2,
  水: 3,
  木: 4,
  金: 5,
  土: 6,
  日: 7,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
  sat: 6,
  sun: 7,
};
const SPLIT_RE = /\/|\||、|\s+(?=\d{1,2}:)/;
/** day, 夜 prefix, from, range separator (`・` = "1 and 2"), to, (evening) suffix */
const MEETING_RE = /^([月火水木金土日]|[a-z]{3,5})\.?(夜|\(evening\))?(\d)(?:([-~〜・])(\d))?(?:時限)?(\(evening\))?$/i;
const ON_DEMAND_RE = /フルOD|on.?demand|オンデマンド/i;
/** A part that is knowingly not a weekly meeting (or empty): neither a slot nor a reason to doubt the cell. */
const NO_MEETING_RE = /^(?:無?その他|others\s*others)?$/i;
/** Weekly-frequency remarks that do not change the slot: `月３時限(隔週)`. */
const FREQUENCY_SUFFIX_RE = /\s*(?:\((?:隔週|毎週)\)|隔週|毎週)$/;
const UNDECIDED_ROOM_RE = /未定|^tbd$/i;
const MAX_PERIOD = 7;

/** NFKC (full-width digits, "／" -> "/") then split into numbered parts; unnumbered parts get a null index. */
function partsOf(text: string | null | undefined): Part[] {
  return (text ?? '')
    .normalize('NFKC')
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d{1,2}):(.*)$/.exec(s);
      return m ? { index: Number(m[1]), body: (m[2] ?? '').trim() } : { index: null, body: s };
    });
}

const keyOf = (part: Part, position: number) => part.index ?? position + 1;

function meetingOf(body: string): Omit<SyllabusSlot, 'classroom' | 'campus'> | null {
  const m = MEETING_RE.exec(body);
  const weekday = DAYS[(m?.[1] ?? '').toLowerCase()];
  if (!m || weekday === undefined) return null;
  const periodFrom = Number(m[3]);
  const periodTo = Number(m[5] ?? m[3]);
  if (periodFrom < 1 || periodTo < periodFrom || periodTo > MAX_PERIOD) return null;
  if (m[4] === '・' && periodTo !== periodFrom + 1) return null; // `1・2` = two periods in a row; `1・3` is no range
  return { weekday, periodFrom, periodTo, night: Boolean(m[2] ?? m[6]) };
}

/** The room that belongs to slot `key`: the part with the same number, or the only room listed when it has none. */
function roomOf(rooms: Part[], key: number): string | null {
  const [only] = rooms;
  const shared = rooms.length === 1 && only?.index === null ? only : undefined;
  const hit = rooms.find((r, i) => keyOf(r, i) === key) ?? shared;
  const name = hit?.body.trim() ?? '';
  return name && !UNDECIDED_ROOM_RE.test(name) ? name : null;
}

export function parseSchedule(cells: {
  dayPeriod: string | null;
  classroom?: string | null;
  campus?: string | null;
}): Schedule {
  const rooms = partsOf(cells.classroom);
  const campus = cells.campus?.trim() || null;
  const slots: SyllabusSlot[] = [];
  let onDemand = false;
  let scheduleUnparsed = false;
  partsOf(cells.dayPeriod).forEach((part, position) => {
    const body = part.body.replace(FREQUENCY_SUFFIX_RE, '');
    const meeting = meetingOf(body);
    if (meeting) slots.push({ ...meeting, classroom: roomOf(rooms, keyOf(part, position)), campus });
    else if (ON_DEMAND_RE.test(body)) onDemand = true;
    else if (!NO_MEETING_RE.test(body)) scheduleUnparsed = true;
  });
  return { slots, onDemand, scheduleUnparsed };
}
