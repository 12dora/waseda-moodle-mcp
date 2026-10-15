/** Shared helpers for the D1 store modules. */

import { normalizeScheduleOverrides } from '../../core/services/schedule-overrides';
import { DEFAULT_SETTINGS, type UiLang, type UserSettings, type WriteMode } from '../../core/types';

const WRITE_MODES: readonly WriteMode[] = ['off', 'chat', 'console'];
const UI_LANGS: readonly UiLang[] = ['auto', 'ja', 'en', 'zh-CN'];

/** Coerce arbitrary stored/posted JSON into valid settings (unknown fields dropped, defaults filled). */
export function normalizeSettings(input: unknown): UserSettings {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const writeMode = WRITE_MODES.find((m) => m === o.writeMode) ?? DEFAULT_SETTINGS.writeMode;
  const uiLang = UI_LANGS.find((l) => l === o.uiLang) ?? DEFAULT_SETTINGS.uiLang;
  // rows saved before it existed read as {}; entries without `night` / `alsoOnDemand` read them as false
  const scheduleOverrides = normalizeScheduleOverrides(o.scheduleOverrides);
  return { writeMode, myCourseIds: normalizeCourseIds(o.myCourseIds), uiLang, scheduleOverrides };
}

/** null stays null ("not confirmed yet"); a list is deduplicated and stripped of non-positive / non-integer entries. */
function normalizeCourseIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((n): n is number => Number.isInteger(n) && n > 0))];
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const toJson = (v: unknown): string => JSON.stringify(v);

/** UPDATE the given columns of one row; `undefined` values are skipped, `null` is written as NULL. */
export async function updateColumns(
  db: D1Database,
  target: { table: string; keyColumn: string; key: string | number },
  columns: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([col]) => `${col} = ?`).join(', ');
  await db
    .prepare(`UPDATE ${target.table} SET ${sets} WHERE ${target.keyColumn} = ?`)
    .bind(...entries.map(([, v]) => v), target.key)
    .run();
}

export async function changes(stmt: D1PreparedStatement): Promise<number> {
  return (await stmt.run()).meta?.changes ?? 0;
}
