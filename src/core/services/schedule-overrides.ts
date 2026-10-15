/** The user's own class times per course: validation and the settings update (console API and MCP tool share it). */

import type { ServiceContext } from '../context';
import { InvalidInput } from '../errors';
import { nowMs } from '../time';
import type { ScheduleOverride } from '../types';
import { resolveScope } from './scope';

type Overrides = Record<string, ScheduleOverride>;
type Slot = ScheduleOverride['slots'][number];

const MODES: readonly ScheduleOverride['mode'][] = ['slots', 'on-demand', 'none'];
const MAX_OVERRIDES = 60;
const MAX_SLOTS = 6;
const MAX_CLASSROOM = 40;
const LAST_WEEKDAY = 7;
const LAST_PERIOD = 7;
const MAX_COURSE_ID = 2_147_483_647;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function parseClassroom(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new InvalidInput('classroom must be text.');
  const room = v.trim();
  if (room.length > MAX_CLASSROOM) throw new InvalidInput(`classroom must be at most ${MAX_CLASSROOM} characters.`);
  return room === '' ? null : room;
}

function parseSlot(v: unknown): Slot {
  if (!isRecord(v)) throw new InvalidInput('Each slot needs weekday, periodFrom, periodTo and classroom.');
  const { weekday, periodFrom, periodTo } = v;
  if (!isInt(weekday, 1, LAST_WEEKDAY)) throw new InvalidInput('weekday must be 1 (Monday) to 7 (Sunday).');
  if (!isInt(periodFrom, 1, LAST_PERIOD) || !isInt(periodTo, 1, LAST_PERIOD) || periodFrom > periodTo) {
    throw new InvalidInput(`periodFrom and periodTo must be periods 1 to ${LAST_PERIOD}, periodFrom first.`);
  }
  return { weekday, periodFrom, periodTo, classroom: parseClassroom(v.classroom) };
}

/** Strict: throws InvalidInput. Slots are kept only for mode 'slots' (1 to MAX_SLOTS of them). */
function parseOverride(v: unknown): ScheduleOverride {
  if (!isRecord(v)) throw new InvalidInput('A course schedule needs a mode and, for mode slots, its slots.');
  const mode = MODES.find((m) => m === v.mode);
  if (mode === undefined) throw new InvalidInput('mode must be slots, on-demand or none.');
  if (mode !== 'slots') return { mode, slots: [] };
  const slots = v.slots;
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > MAX_SLOTS) {
    throw new InvalidInput(`mode slots needs 1 to ${MAX_SLOTS} slots.`);
  }
  return { mode, slots: slots.map((s) => parseSlot(s)) };
}

/** Keys are course ids as plain decimal text. */
function courseIdOf(key: string): number {
  const id = Number(key);
  if (!/^[1-9]\d*$/.test(key) || id > MAX_COURSE_ID) throw new InvalidInput(`${key} is not a course id.`);
  return id;
}

/** Lenient, for stored settings: a missing key reads as {}; an entry that no longer validates is dropped. */
export function normalizeScheduleOverrides(value: unknown): Overrides {
  const out: Overrides = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_OVERRIDES) break;
    try {
      courseIdOf(key);
      out[key] = parseOverride(raw);
    } catch {
      /* corrupt or retired entry */
    }
  }
  return out;
}

async function requireEnrolled(ctx: ServiceContext, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const enrolled = new Set((await resolveScope(ctx)).courses.map((c) => c.id));
  const unknown = ids.filter((id) => !enrolled.has(id));
  if (unknown.length) throw new InvalidInput(`Not enrolled in course(s): ${unknown.join(', ')}.`);
}

/**
 * Validates `{ [courseId]: override | null }` completely (shape, limits, enrolment) without writing anything, so a
 * caller can check every part of a request before it applies the first one. `null` removes the course's entry.
 */
export async function validateScheduleOverrides(
  ctx: ServiceContext,
  raw: unknown,
): Promise<Map<number, ScheduleOverride | null>> {
  if (!isRecord(raw)) throw new InvalidInput('scheduleOverrides must be an object keyed by course id.');
  const entries = Object.entries(raw);
  if (entries.length > MAX_OVERRIDES) throw new InvalidInput(`At most ${MAX_OVERRIDES} course schedules can be set.`);
  const changes = new Map<number, ScheduleOverride | null>();
  for (const [key, value] of entries) changes.set(courseIdOf(key), value === null ? null : parseOverride(value));
  await requireEnrolled(
    ctx,
    [...changes].filter(([, o]) => o !== null).map(([id]) => id),
  );
  return changes;
}

/** Writes validated changes in one settings update (our own stored choice, nothing in Moodle); returns the new map. */
export async function applyScheduleOverrides(
  ctx: ServiceContext,
  changes: ReadonlyMap<number, ScheduleOverride | null>,
): Promise<Overrides> {
  if (changes.size === 0) return ctx.user.settings.scheduleOverrides;
  const merged = new Map(Object.entries(ctx.user.settings.scheduleOverrides));
  for (const [id, override] of changes) {
    if (override === null) merged.delete(String(id));
    else merged.set(String(id), override);
  }
  if (merged.size > MAX_OVERRIDES) throw new InvalidInput(`At most ${MAX_OVERRIDES} course schedules can be set.`);
  const scheduleOverrides = Object.fromEntries(merged);
  const next = { ...ctx.user.settings, scheduleOverrides };
  await ctx.store.updateSettings(ctx.user.id, next);
  ctx.user.settings = next;
  await ctx.store.audit({
    userId: ctx.user.id,
    at: nowMs(),
    actor: `mcp:${ctx.source}`,
    action: 'settings:schedule_override',
    detail: { changed: changes.size, total: merged.size },
  });
  return scheduleOverrides;
}

/** `null` returns the course to the automatic sources (syllabus, then Moodle attendance). */
export async function setScheduleOverride(
  ctx: ServiceContext,
  courseId: number,
  override: ScheduleOverride | null,
): Promise<Overrides> {
  return applyScheduleOverrides(ctx, await validateScheduleOverrides(ctx, { [courseId]: override }));
}
