import type { AuditRow, Store } from '../../core/context';
import { changes, parseJson, toJson } from './rows';

export const AUDIT_RETENTION_MS = 90 * 86_400_000;
const COURSE_INDEX_RETENTION_MS = 30 * 86_400_000;

interface AuditRaw {
  id: number;
  user_id: number;
  at: number;
  actor: string;
  action: string;
  detail: string | null;
}

interface CourseIndexRaw {
  user_id: number;
  course_id: number;
  json: string;
  updated_at: number;
}

const toAudit = (r: AuditRaw): AuditRow => ({
  id: r.id,
  userId: r.user_id,
  at: r.at,
  actor: r.actor,
  action: r.action,
  detail: parseJson<Record<string, unknown> | null>(r.detail, null),
});

type LogMethods = Pick<Store, 'getCourseIndex' | 'putCourseIndex' | 'audit' | 'listAudit'>;

export function logMethods(db: D1Database): LogMethods {
  return {
    async getCourseIndex(userId) {
      const { results } = await db
        .prepare('SELECT * FROM course_index WHERE user_id = ? ORDER BY course_id')
        .bind(userId)
        .all<CourseIndexRaw>();
      return results.map((r) => ({ userId: r.user_id, courseId: r.course_id, json: r.json, updatedAt: r.updated_at }));
    },

    async putCourseIndex(row) {
      await db
        .prepare(
          `INSERT INTO course_index (user_id, course_id, json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, course_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
        )
        .bind(row.userId, row.courseId, row.json, row.updatedAt)
        .run();
    },

    async audit(row) {
      await db
        .prepare('INSERT INTO audit (user_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
        .bind(row.userId, row.at, row.actor, row.action, row.detail ? toJson(row.detail) : null)
        .run();
    },

    /** `before` is a row-id cursor (rows carry their `id`): newest first, strictly older than the given id. */
    async listAudit(userId, opts) {
      const where = ['user_id = ?'];
      const args: unknown[] = [userId];
      if (opts.before !== undefined) {
        where.push('id < ?');
        args.push(opts.before);
      }
      const { results } = await db
        .prepare(`SELECT * FROM audit WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
        .bind(...args, Math.max(1, Math.floor(opts.limit)))
        .all<AuditRaw>();
      return results.map(toAudit);
    },
  };
}

/** Daily retention sweep. Returns the number of rows removed/expired per table. */
export async function purgeExpired(db: D1Database, now: number): Promise<Record<string, number>> {
  const run = (sql: string, ...args: unknown[]) => changes(db.prepare(sql).bind(...args));
  return {
    audit: await run('DELETE FROM audit WHERE at < ?', now - AUDIT_RETENTION_MS),
    sessions: await run('DELETE FROM sessions WHERE expires_at < ?', now),
    uploadDrafts: await run('DELETE FROM upload_drafts WHERE expires_at < ?', now),
    handoffs: await run('DELETE FROM handoffs WHERE expires_at < ?', now),
    actionsExpired: await run("UPDATE actions SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", now),
    actionsDeleted: await run(
      "DELETE FROM actions WHERE status != 'pending' AND created_at < ?",
      now - AUDIT_RETENTION_MS,
    ),
    courseIndex: await run('DELETE FROM course_index WHERE updated_at < ?', now - COURSE_INDEX_RETENTION_MS),
  };
}
