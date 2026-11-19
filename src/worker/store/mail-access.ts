/** Mail access applications and operator decisions (migrations/0013_mail_access.sql). */

import type {
  MailAccessChange,
  MailAccessListItem,
  MailAccessMethods,
  MailAccessRow,
  MailAccessStatus,
} from '../../core/mail/access';
import { changes } from './rows';

interface MailAccessRaw {
  user_id: number;
  status: MailAccessStatus;
  requested_at: number;
  decided_at: number | null;
  decided_by: number | null;
}

interface MailAccessListRaw extends MailAccessRaw {
  fullname: string;
  moodle_user_id: number;
  address: string | null;
  mail_status: 'active' | 'invalid' | null;
}

const toMailAccess = (r: MailAccessRaw): MailAccessRow => ({
  userId: r.user_id,
  status: r.status,
  requestedAt: r.requested_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
});

const toListItem = (r: MailAccessListRaw): MailAccessListItem => ({
  userId: r.user_id,
  fullname: r.fullname,
  moodleUserId: r.moodle_user_id,
  status: r.status,
  requestedAt: r.requested_at,
  decidedAt: r.decided_at,
  connection: r.address !== null && r.mail_status !== null ? { address: r.address, status: r.mail_status } : null,
});

const SELECT_ONE = 'SELECT * FROM mail_access WHERE user_id = ?';
/** Leaves out the users (alias u) whose Moodle id is in the bound JSON array: the one place operators are filtered. */
const NOT_EXCEPTED = 'u.moodle_user_id NOT IN (SELECT value FROM json_each(?))';

function decideStatement(db: D1Database, userId: number, change: MailAccessChange): D1PreparedStatement {
  const { status, by, at, from } = change;
  if (from === null) {
    return db
      .prepare(
        `INSERT INTO mail_access (user_id, status, requested_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, decided_at = excluded.decided_at,
           decided_by = excluded.decided_by`,
      )
      .bind(userId, status, at, at, by);
  }
  const states = from.map(() => '?').join(', ');
  return db
    .prepare(
      `UPDATE mail_access SET status = ?, decided_at = ?, decided_by = ?
       WHERE user_id = ? AND status IN (${states || 'NULL'})`,
    )
    .bind(status, at, by, userId, ...from);
}

export function mailAccessMethods(db: D1Database): MailAccessMethods {
  return {
    async getMailAccess(userId) {
      const r = await db.prepare(SELECT_ONE).bind(userId).first<MailAccessRaw>();
      return r ? toMailAccess(r) : null;
    },

    async requestMailAccess(userId, at) {
      const res = await db.batch([
        db
          .prepare(
            `INSERT INTO mail_access (user_id, status, requested_at) VALUES (?, 'pending', ?)
             ON CONFLICT(user_id) DO UPDATE SET status = 'pending', requested_at = excluded.requested_at,
               decided_at = NULL, decided_by = NULL
             WHERE mail_access.status = 'rejected'`,
          )
          .bind(userId, at),
        db.prepare(SELECT_ONE).bind(userId),
      ]);
      const raw = (res[1]?.results as MailAccessRaw[] | undefined)?.[0];
      if (!raw) throw new Error('requestMailAccess: row missing after insert');
      return toMailAccess(raw);
    },

    async decideMailAccess(userId, change) {
      return (await changes(decideStatement(db, userId, change))) === 1;
    },

    async listMailAccess({ status, limit, except }) {
      const { results } = await db
        .prepare(
          `SELECT a.*, u.fullname, u.moodle_user_id, m.address, m.status AS mail_status
           FROM mail_access a JOIN users u ON u.id = a.user_id LEFT JOIN mail_credentials m ON m.user_id = a.user_id
           WHERE (? IS NULL OR a.status = ?) AND ${NOT_EXCEPTED}
           ORDER BY a.requested_at DESC, a.user_id DESC LIMIT ?`,
        )
        .bind(status ?? null, status ?? null, JSON.stringify(except), Math.max(1, Math.floor(limit)))
        .all<MailAccessListRaw>();
      return results.map(toListItem);
    },

    async countMailAccess(status, except) {
      const r = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM mail_access a JOIN users u ON u.id = a.user_id
           WHERE a.status = ? AND ${NOT_EXCEPTED}`,
        )
        .bind(status, JSON.stringify(except))
        .first<{ n: number }>();
      return r?.n ?? 0;
    },

    async listUnapprovedMailOwners(limit) {
      const { results } = await db
        .prepare(
          `SELECT m.user_id, u.moodle_user_id
           FROM mail_credentials m JOIN users u ON u.id = m.user_id LEFT JOIN mail_access a ON a.user_id = m.user_id
           WHERE a.status IS NULL OR a.status <> 'approved'
           ORDER BY m.user_id LIMIT ?`,
        )
        .bind(Math.max(1, Math.floor(limit)))
        .all<{ user_id: number; moodle_user_id: number }>();
      return results.map((r) => ({ userId: r.user_id, moodleUserId: r.moodle_user_id }));
    },
  };
}
