/** Shared helpers for the D1 store modules. */

import { DEFAULT_SETTINGS, type UiLang, type UserSettings, type WriteMode } from '../../core/types';

const WRITE_MODES: readonly WriteMode[] = ['off', 'chat', 'console'];
const UI_LANGS: readonly UiLang[] = ['auto', 'ja', 'en', 'zh-CN'];

/** Coerce arbitrary stored/posted JSON into valid settings (unknown fields dropped, defaults filled). */
export function normalizeSettings(input: unknown): UserSettings {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const writeMode = WRITE_MODES.find((m) => m === o.writeMode) ?? DEFAULT_SETTINGS.writeMode;
  const uiLang = UI_LANGS.find((l) => l === o.uiLang) ?? DEFAULT_SETTINGS.uiLang;
  const hidden = Array.isArray(o.hiddenCourseIds)
    ? [...new Set(o.hiddenCourseIds.filter((n): n is number => Number.isInteger(n) && (n as number) > 0))]
    : [];
  return { writeMode, hiddenCourseIds: hidden, uiLang };
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
