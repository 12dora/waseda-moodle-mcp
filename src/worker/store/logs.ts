import type { AuditRow, Store } from '../../core/context';
import { changes, parseJson, toJson } from './rows';

export const AUDIT_RETENTION_MS = 90 * 86_400_000;
const RATE_LIMIT_RETENTION_MS = 86_400_000;
const COURSE_SNAPSHOT_RETENTION_MS = 30 * 86_400_000;
const INFERRED_SCHEDULE_RETENTION_MS = 30 * 86_400_000; // read for 7 days; older rows only serve as a fallback
const SYLLABUS_RETENTION_MS = 400 * 86_400_000; // a syllabus is valid for its academic year

interface AuditRaw {
  id: number;
  user_id: number;
  at: number;
  actor: string;
  action: string;
  detail: string | null;
}

const toAudit = (r: AuditRaw): AuditRow => ({
  id: r.id,
  userId: r.user_id,
  at: r.at,
  actor: r.actor,
  action: r.action,
  detail: parseJson<Record<string, unknown> | null>(r.detail, null),
});

type LogMethods = Pick<Store, 'audit' | 'listAudit'>;

export function logMethods(db: D1Database): LogMethods {
  return {
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
    oauthRequests: await run('DELETE FROM oauth_requests WHERE expires_at < ?', now),
    rateLimits: await run('DELETE FROM rate_limits WHERE window_start < ?', now - RATE_LIMIT_RETENTION_MS),
    revokedKeys: await run(
      'DELETE FROM api_keys WHERE revoked_at IS NOT NULL AND revoked_at < ?',
      now - AUDIT_RETENTION_MS,
    ),
    actionsExpired: await run("UPDATE actions SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", now),
    actionsDeleted: await run(
      "DELETE FROM actions WHERE status != 'pending' AND created_at < ?",
      now - AUDIT_RETENTION_MS,
    ),
    syllabusCache: await run('DELETE FROM syllabus_cache WHERE fetched_at < ?', now - SYLLABUS_RETENTION_MS),
    courseSnapshots: await run('DELETE FROM course_snapshots WHERE checked_at < ?', now - COURSE_SNAPSHOT_RETENTION_MS),
    inferredSchedules: await run(
      'DELETE FROM inferred_schedules WHERE checked_at < ?',
      now - INFERRED_SCHEDULE_RETENTION_MS,
    ),
  };
}
