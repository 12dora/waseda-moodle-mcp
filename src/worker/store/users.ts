import type { CredentialRow, Store, UserRow } from '../../core/context';
import { type ConnectVia, DEFAULT_SETTINGS } from '../../core/types';
import { normalizeSettings, parseJson, toJson, updateColumns } from './rows';

export interface UserRaw {
  id: number;
  moodle_user_id: number;
  fullname: string;
  lang: string;
  settings: string;
  created_at: number;
  last_seen_at: number | null;
}

interface CredentialRaw {
  user_id: number;
  token_enc: string;
  private_token_enc: string | null;
  token_hash: string;
  token_hint: string;
  status: 'active' | 'invalid';
  connected_via: string;
  connected_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

export const toUser = (r: UserRaw): UserRow => ({
  id: r.id,
  moodleUserId: r.moodle_user_id,
  fullname: r.fullname,
  lang: r.lang,
  settings: normalizeSettings(parseJson(r.settings, {})),
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

const toCredential = (r: CredentialRaw): CredentialRow => ({
  userId: r.user_id,
  tokenEnc: r.token_enc,
  privateTokenEnc: r.private_token_enc,
  tokenHash: r.token_hash,
  tokenHint: r.token_hint,
  status: r.status,
  connectedVia: r.connected_via as ConnectVia,
  connectedAt: r.connected_at,
  lastOkAt: r.last_ok_at,
  lastError: r.last_error,
});

/** Tables that hang off a user (deleted explicitly so correctness does not depend on FK enforcement). */
const USER_OWNED_TABLES = [
  'credentials',
  'sessions',
  'api_keys',
  'actions',
  'upload_drafts',
  'course_snapshots',
  'audit',
] as const;

type UserMethods = Pick<
  Store,
  | 'getUser'
  | 'getUserByMoodleId'
  | 'upsertUser'
  | 'updateSettings'
  | 'touchUser'
  | 'deleteUser'
  | 'getCredential'
  | 'putCredential'
  | 'updateCredentialStatus'
>;

export function userMethods(db: D1Database): UserMethods {
  const getUserByMoodleId: UserMethods['getUserByMoodleId'] = async (moodleUserId) => {
    const r = await db.prepare('SELECT * FROM users WHERE moodle_user_id = ?').bind(moodleUserId).first<UserRaw>();
    return r ? toUser(r) : null;
  };

  return {
    async getUser(id) {
      const r = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRaw>();
      return r ? toUser(r) : null;
    },

    getUserByMoodleId,

    async upsertUser(input) {
      const now = Date.now();
      await db
        .prepare(
          `INSERT INTO users (moodle_user_id, fullname, lang, settings, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(moodle_user_id) DO UPDATE SET fullname = excluded.fullname, lang = excluded.lang`,
        )
        .bind(input.moodleUserId, input.fullname, input.lang, toJson(DEFAULT_SETTINGS), now, now)
        .run();
      const row = await getUserByMoodleId(input.moodleUserId);
      if (!row) throw new Error('upsertUser: row missing after insert');
      return row;
    },

    async updateSettings(userId, settings) {
      await db
        .prepare('UPDATE users SET settings = ? WHERE id = ?')
        .bind(toJson(normalizeSettings(settings)), userId)
        .run();
    },

    async touchUser(userId, at) {
      await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(at, userId).run();
    },

    async deleteUser(userId) {
      const stmts = USER_OWNED_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId));
      stmts.push(db.prepare('DELETE FROM users WHERE id = ?').bind(userId));
      await db.batch(stmts);
    },

    async getCredential(userId) {
      const r = await db.prepare('SELECT * FROM credentials WHERE user_id = ?').bind(userId).first<CredentialRaw>();
      return r ? toCredential(r) : null;
    },

    async putCredential(row) {
      await db
        .prepare(
          `INSERT INTO credentials (user_id, token_enc, private_token_enc, token_hash, token_hint, status,
             connected_via, connected_at, last_ok_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET token_enc = excluded.token_enc,
             private_token_enc = excluded.private_token_enc, token_hash = excluded.token_hash,
             token_hint = excluded.token_hint, status = excluded.status, connected_via = excluded.connected_via,
             connected_at = excluded.connected_at, last_ok_at = excluded.last_ok_at, last_error = excluded.last_error`,
        )
        .bind(
          row.userId,
          row.tokenEnc,
          row.privateTokenEnc ?? null,
          row.tokenHash,
          row.tokenHint,
          row.status,
          row.connectedVia,
          row.connectedAt,
          row.lastOkAt ?? null,
          row.lastError ?? null,
        )
        .run();
    },

    async updateCredentialStatus(userId, patch) {
      await updateColumns(
        db,
        { table: 'credentials', keyColumn: 'user_id', key: userId },
        { status: patch.status, last_ok_at: patch.lastOkAt, last_error: patch.lastError },
      );
    },
  };
}
