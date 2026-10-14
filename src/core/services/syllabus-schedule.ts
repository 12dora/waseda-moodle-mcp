/**
 * The meeting slots of one syllabus: the `学期曜日時限` day/period text (after the term) plus the `使用教室` and
 * `キャンパス` cells. Pure parsing; see r6-report §2 for the grammar:
 *   slot  := [index ":"] ( フルOD | 無その他 | 月１-２ | 木夜６-７ | 火４時限 | Thur.6-7(evening) )
 *   cells := slot ( "／" | "<br>" | "、" | " 02:" ) slot ...
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
const MEETING_RE = /^([月火水木金土日]|[a-z]{3,5})\.?(夜|\(evening\))?(\d)(?:[-~〜](\d))?(?:時限)?(\(evening\))?$/i;
const ON_DEMAND_RE = /フルOD|on.?demand|オンデマンド/i;
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
  const periodTo = Number(m[4] ?? m[3]);
  if (periodFrom < 1 || periodTo < periodFrom || periodTo > MAX_PERIOD) return null;
  return { weekday, periodFrom, periodTo, night: Boolean(m[2] ?? m[5]) };
}

/** The room that belongs to slot `key`: the part with the same number, or the only room listed. */
function roomOf(rooms: Part[], key: number): string | null {
  const hit = rooms.find((r, i) => keyOf(r, i) === key) ?? (rooms.length === 1 ? rooms[0] : undefined);
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
  partsOf(cells.dayPeriod).forEach((part, position) => {
    onDemand ||= ON_DEMAND_RE.test(part.body);
    const meeting = meetingOf(part.body);
    if (meeting) slots.push({ ...meeting, classroom: roomOf(rooms, keyOf(part, position)), campus });
  });
  return { slots, onDemand };
}
