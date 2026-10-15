/** Per-user class times inferred from Moodle attendance sessions (services/timetable/moodle-slots). */

import type { Store } from '../../core/context';
import type { InferredSchedule } from '../../core/types';
import { parseJson, toJson } from './rows';

interface InferredRaw {
  course_id: number;
  json: string;
  checked_at: number;
}

type InferredMethods = Pick<Store, 'getInferredSchedules' | 'putInferredSchedules'>;

/** A row that no longer parses is treated as missing (the schedule is inferred again). */
function toSchedule(r: InferredRaw): InferredSchedule | null {
  const j = parseJson<Partial<InferredSchedule> | null>(r.json, null);
  if (!j || !Array.isArray(j.slots)) return null;
  return { slots: j.slots, firstDate: j.firstDate ?? null, lastDate: j.lastDate ?? null, checkedAt: r.checked_at };
}

export function inferredMethods(db: D1Database): InferredMethods {
  return {
    /** One row per course of the user (a few dozen at most), so no IN list. */
    async getInferredSchedules(userId) {
      const { results } = await db
        .prepare('SELECT course_id, json, checked_at FROM inferred_schedules WHERE user_id = ?')
        .bind(userId)
        .all<InferredRaw>();
      const out = new Map<number, InferredSchedule>();
      for (const r of results) {
        const schedule = toSchedule(r);
        if (schedule) out.set(r.course_id, schedule);
      }
      return out;
    },

    async putInferredSchedules(userId, schedules) {
      const stmts = [...schedules].map(([courseId, { checkedAt, ...rest }]) =>
        db
          .prepare(
            `INSERT INTO inferred_schedules (user_id, course_id, json, checked_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, course_id) DO UPDATE SET json = excluded.json, checked_at = excluded.checked_at`,
          )
          .bind(userId, courseId, toJson(rest), checkedAt),
      );
      if (stmts.length > 0) await db.batch(stmts);
    },
  };
}
