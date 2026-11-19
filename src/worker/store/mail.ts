/** Waseda mailbox connections (one row per user) and the lifetime mail slots (migrations/0012_mail.sql). */

import type { MailCredentialPatch, MailCredentialRow, Store } from '../../core/context';
import { changes, updateColumns, updateStatement } from './rows';

interface MailCredentialRaw {
  user_id: number;
  address: string;
  google_sub: string | null;
  refresh_enc: string | null;
  scopes: string;
  status: 'active' | 'invalid';
  connected_at: number;
  last_used_at: number | null;
  last_error: string | null;
  idle_tried_at: number | null;
}

type MailMethods = Pick<
  Store,
  | 'getMailCredential'
  | 'putMailCredential'
  | 'updateMailCredential'
  | 'updateMailCredentialIf'
  | 'deleteMailCredential'
  | 'listIdleMailCredentials'
  | 'countMailSlots'
  | 'hasMailSlot'
  | 'takeMailSlot'
>;

const toMailCredential = (r: MailCredentialRaw): MailCredentialRow => ({
  userId: r.user_id,
  address: r.address,
  googleSub: r.google_sub,
  refreshEnc: r.refresh_enc,
  scopes: r.scopes.split(' ').filter(Boolean),
  status: r.status,
  connectedAt: r.connected_at,
  lastUsedAt: r.last_used_at,
  lastError: r.last_error,
  idleTriedAt: r.idle_tried_at,
});

const PATCH_COLUMNS: Record<keyof MailCredentialPatch, string> = {
  refreshEnc: 'refresh_enc',
  status: 'status',
  lastUsedAt: 'last_used_at',
  lastError: 'last_error',
  idleTriedAt: 'idle_tried_at',
};

function patchColumns(patch: MailCredentialPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const column = PATCH_COLUMNS[k as keyof MailCredentialPatch];
    if (column && v !== undefined) out[column] = v;
  }
  return out;
}

/** When the connection was last used, or (never used) made. */
const LAST_USE = 'COALESCE(last_used_at, connected_at)';

export function mailMethods(db: D1Database): MailMethods {
  return {
    async getMailCredential(userId) {
      const r = await db
        .prepare('SELECT * FROM mail_credentials WHERE user_id = ?')
        .bind(userId)
        .first<MailCredentialRaw>();
      return r ? toMailCredential(r) : null;
    },

    async putMailCredential(row) {
      await db
        .prepare(
          `INSERT INTO mail_credentials (user_id, address, google_sub, refresh_enc, scopes, status, connected_at,
             last_used_at, last_error, idle_tried_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET address = excluded.address, google_sub = excluded.google_sub,
             refresh_enc = excluded.refresh_enc, scopes = excluded.scopes, status = excluded.status,
             connected_at = excluded.connected_at, last_used_at = excluded.last_used_at,
             last_error = excluded.last_error, idle_tried_at = excluded.idle_tried_at`,
        )
        .bind(
          row.userId,
          row.address,
          row.googleSub,
          row.refreshEnc,
          row.scopes.join(' '),
          row.status,
          row.connectedAt,
          row.lastUsedAt,
          row.lastError,
          row.idleTriedAt,
        )
        .run();
    },

    async updateMailCredential(userId, patch) {
      await updateColumns(db, { table: 'mail_credentials', keyColumn: 'user_id', key: userId }, patchColumns(patch));
    },

    async updateMailCredentialIf(userId, expect, patch) {
      const target = { table: 'mail_credentials', keyColumn: 'user_id', key: userId };
      const guard = { sql: 'refresh_enc IS ?', args: [expect.refreshEnc] };
      const stmt = updateStatement(db, target, patchColumns(patch), guard);
      return stmt ? (await changes(stmt)) === 1 : false;
    },

    async deleteMailCredential(userId) {
      return (await changes(db.prepare('DELETE FROM mail_credentials WHERE user_id = ?').bind(userId))) > 0;
    },

    async listIdleMailCredentials(before, limit) {
      const { results } = await db
        .prepare(
          `SELECT * FROM mail_credentials
           WHERE status = 'active' AND refresh_enc IS NOT NULL AND ${LAST_USE} <= ?
           ORDER BY COALESCE(idle_tried_at, 0) ASC, ${LAST_USE} ASC, user_id LIMIT ?`,
        )
        .bind(before, Math.max(1, Math.floor(limit)))
        .all<MailCredentialRaw>();
      return results.map(toMailCredential);
    },

    async countMailSlots() {
      const r = await db.prepare('SELECT COUNT(*) AS n FROM mail_slots').first<{ n: number }>();
      return r?.n ?? 0;
    },

    async hasMailSlot(moodleUserId) {
      const r = await db.prepare('SELECT 1 AS x FROM mail_slots WHERE moodle_user_id = ?').bind(moodleUserId).first();
      return r !== null;
    },

    async takeMailSlot(moodleUserId, at, limit) {
      // the no-op update makes RETURNING answer for a user who already holds a slot
      const r = await db
        .prepare(
          `INSERT INTO mail_slots (moodle_user_id, created_at)
           SELECT ?, ? WHERE ? IS NULL OR (SELECT COUNT(*) FROM mail_slots) < ?
             OR EXISTS (SELECT 1 FROM mail_slots WHERE moodle_user_id = ?)
           ON CONFLICT(moodle_user_id) DO UPDATE SET created_at = mail_slots.created_at
           RETURNING moodle_user_id`,
        )
        .bind(moodleUserId, at, limit, limit, moodleUserId)
        .first();
      return r !== null;
    },
  };
}
