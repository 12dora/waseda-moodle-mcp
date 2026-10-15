/** Per-course content snapshots (sweep, "what's new", search) and the scheduled-sweep user queue. */

import type { CourseSnapshotRow, Store } from '../../core/context';
import { toJson } from './rows';
import { toUser, type UserRaw } from './users';

interface SnapshotRaw {
  user_id: number;
  course_id: number;
  json: string;
  fetched_at: number;
  checked_at: number;
}

const toSnapshot = (r: SnapshotRaw): CourseSnapshotRow => ({
  userId: r.user_id,
  courseId: r.course_id,
  json: r.json,
  fetchedAt: r.fetched_at,
  checkedAt: r.checked_at,
});

type SnapshotMethods = Pick<
  Store,
  | 'getCourseSnapshots'
  | 'putCourseSnapshot'
  | 'touchCourseSnapshot'
  | 'getSyllabusCache'
  | 'putSyllabusCache'
  | 'listSweepUsers'
  | 'markSwept'
  | 'setScopeCourseIds'
>;

/** D1 allows 100 bound variables per statement. */
const SYLLABUS_IN_CHUNK = 50;

export function snapshotMethods(db: D1Database): SnapshotMethods {
  return {
    async getCourseSnapshots(userId) {
      const { results } = await db
        .prepare('SELECT * FROM course_snapshots WHERE user_id = ? ORDER BY course_id')
        .bind(userId)
        .all<SnapshotRaw>();
      return results.map(toSnapshot);
    },

    async putCourseSnapshot(row) {
      await db
        .prepare(
          `INSERT INTO course_snapshots (user_id, course_id, json, fetched_at, checked_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, course_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at,
             checked_at = excluded.checked_at`,
        )
        .bind(row.userId, row.courseId, row.json, row.fetchedAt, row.checkedAt)
        .run();
    },

    async touchCourseSnapshot(userId, courseId, checkedAt) {
      await db
        .prepare('UPDATE course_snapshots SET checked_at = ? WHERE user_id = ? AND course_id = ?')
        .bind(checkedAt, userId, courseId)
        .run();
    },

    async getSyllabusCache(idnumbers) {
      const out = new Map<string, { json: string; fetchedAt: number }>();
      const unique = [...new Set(idnumbers)];
      for (let i = 0; i < unique.length; i += SYLLABUS_IN_CHUNK) {
        const chunk = unique.slice(i, i + SYLLABUS_IN_CHUNK);
        const { results } = await db
          .prepare(
            `SELECT idnumber, json, fetched_at FROM syllabus_cache WHERE idnumber IN (${chunk.map(() => '?').join(', ')})`,
          )
          .bind(...chunk)
          .all<{ idnumber: string; json: string; fetched_at: number }>();
        for (const r of results) out.set(r.idnumber, { json: r.json, fetchedAt: r.fetched_at });
      }
      return out;
    },

    async putSyllabusCache(idnumber, json, fetchedAt) {
      await db
        .prepare(
          `INSERT INTO syllabus_cache (idnumber, json, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT(idnumber) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
        )
        .bind(idnumber, json, fetchedAt)
        .run();
    },

    /** Never-swept users first, then the least recently swept; the stamp is set even when a sweep failed. */
    async listSweepUsers(limit) {
      const { results } = await db
        .prepare(
          `SELECT u.* FROM users u
           JOIN credentials c ON c.user_id = u.id AND c.status = 'active'
           ORDER BY u.last_swept_at ASC NULLS FIRST, u.id ASC
           LIMIT ?`,
        )
        .bind(Math.max(1, Math.floor(limit)))
        .all<UserRaw>();
      return results.map(toUser);
    },

    async markSwept(userId, at) {
      await db.prepare('UPDATE users SET last_swept_at = ? WHERE id = ?').bind(at, userId).run();
    },

    /** The WHERE clause makes an unchanged list a no-op: D1 bills a row write only for a row that is updated. */
    async setScopeCourseIds(userId, ids) {
      const json = toJson([...new Set(ids)].sort((a, b) => a - b));
      await db
        .prepare('UPDATE users SET scope_course_ids = ? WHERE id = ? AND scope_course_ids IS NOT ?')
        .bind(json, userId, json)
        .run();
    },
  };
}
