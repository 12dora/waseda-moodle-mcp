import type { CredentialPatch, CredentialRow, Store, UserRow } from '../../core/context';
import { type ConnectVia, DEFAULT_SETTINGS } from '../../core/types';
import { usagePeriods } from '../../core/usage';
import { changes, normalizeSettings, parseJson, toJson, updateColumns } from './rows';

export interface UserRaw {
  id: number;
  moodle_user_id: number;
  fullname: string;
  lang: string;
  settings: string;
  created_at: number;
  last_seen_at: number | null;
  scope_course_ids?: string | null; // 0005: the last interactive scope, JSON array
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
  session_enc: string | null; // 0009
  session_ok_at: number | null;
  session_tried_at: number | null;
  renewed_at: number | null;
  autologin_at: number | null;
}

function scopeIds(raw: string | null | undefined): number[] | undefined {
  const ids = parseJson<unknown>(raw, null);
  return Array.isArray(ids) ? ids.filter((n): n is number => Number.isInteger(n)) : undefined;
}

export const toUser = (r: UserRaw): UserRow => ({
  id: r.id,
  moodleUserId: r.moodle_user_id,
  fullname: r.fullname,
  lang: r.lang,
  settings: normalizeSettings(parseJson(r.settings, {})),
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  scopeCourseIds: scopeIds(r.scope_course_ids),
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
  sessionEnc: r.session_enc,
  sessionOkAt: r.session_ok_at,
  sessionTriedAt: r.session_tried_at,
  renewedAt: r.renewed_at,
  autologinAt: r.autologin_at,
});

const CREDENTIAL_COLUMNS: Record<keyof CredentialPatch, string> = {
  tokenEnc: 'token_enc',
  privateTokenEnc: 'private_token_enc',
  tokenHash: 'token_hash',
  tokenHint: 'token_hint',
  status: 'status',
  lastOkAt: 'last_ok_at',
  lastError: 'last_error',
  sessionEnc: 'session_enc',
  sessionOkAt: 'session_ok_at',
  sessionTriedAt: 'session_tried_at',
  renewedAt: 'renewed_at',
  autologinAt: 'autologin_at',
};

/** Patch fields -> column values (undefined fields are left out by updateColumns / setClause). */
function credentialColumns(patch: CredentialPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const column = CREDENTIAL_COLUMNS[k as keyof CredentialPatch];
    if (column && v !== undefined) out[column] = v;
  }
  return out;
}

/** Tables that hang off a user (deleted explicitly so correctness does not depend on FK enforcement). */
const USER_OWNED_TABLES = [
  'credentials',
  'sessions',
  'api_keys',
  'actions',
  'upload_drafts',
  'course_snapshots',
  'inferred_schedules',
  'calendar_feeds',
  'audit',
] as const;

type AccountMethods = Pick<
  Store,
  'getUser' | 'getUserByMoodleId' | 'upsertUser' | 'updateSettings' | 'touchUser' | 'deleteUser'
>;
type CredentialMethods = Pick<
  Store,
  'getCredential' | 'putCredential' | 'updateCredentialStatus' | 'updateCredentialIf' | 'listRenewalCandidates'
>;

export function userMethods(db: D1Database): AccountMethods & CredentialMethods {
  return { ...accountMethods(db), ...credentialMethods(db) };
}

function accountMethods(db: D1Database): AccountMethods {
  const getUserByMoodleId: AccountMethods['getUserByMoodleId'] = async (moodleUserId) => {
    const r = await db.prepare('SELECT * FROM users WHERE moodle_user_id = ?').bind(moodleUserId).first<UserRaw>();
    return r ? toUser(r) : null;
  };

  return {
    async getUser(id) {
      const r = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRaw>();
      return r ? toUser(r) : null;
    },

    getUserByMoodleId,

    /**
     * One batch: a NEW account also adds one to its signup week's anonymous size (the retention denominator, kept
     * when the account is deleted later); an existing one only gets its name and language refreshed.
     */
    async upsertUser(input) {
      const now = Date.now();
      const res = await db.batch([
        db
          .prepare(
            `INSERT INTO users (moodle_user_id, fullname, lang, settings, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(moodle_user_id) DO NOTHING`,
          )
          .bind(input.moodleUserId, input.fullname, input.lang, toJson(DEFAULT_SETTINGS), now, now),
        db
          .prepare(
            `INSERT INTO usage_counts (period, metric, dim, value) SELECT ?, 'signups', '', 1 WHERE changes() = 1
             ON CONFLICT(period, metric, dim) DO UPDATE SET value = value + 1`,
          )
          .bind(usagePeriods(now).week),
        db
          .prepare('UPDATE users SET fullname = ?, lang = ? WHERE moodle_user_id = ?')
          .bind(input.fullname, input.lang, input.moodleUserId),
        db.prepare('SELECT * FROM users WHERE moodle_user_id = ?').bind(input.moodleUserId),
      ]);
      const raw = (res[3]?.results as UserRaw[] | undefined)?.[0];
      if (!raw) throw new Error('upsertUser: row missing after insert');
      return toUser(raw);
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
  };
}

function credentialMethods(db: D1Database): CredentialMethods {
  return {
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
      await updateColumns(db, { table: 'credentials', keyColumn: 'user_id', key: userId }, credentialColumns(patch));
    },

    async updateCredentialIf(userId, expect, patch) {
      const sets = Object.entries(credentialColumns(patch));
      const where = ['user_id = ?', 'token_hash = ?'];
      const args: unknown[] = [userId, expect.tokenHash];
      if (expect.sessionEnc !== undefined) {
        where.push('session_enc IS ?');
        args.push(expect.sessionEnc);
      }
      if (expect.autologinAt !== undefined) {
        where.push('autologin_at IS ?');
        args.push(expect.autologinAt);
      }
      if (sets.length === 0) sets.push(['user_id', userId]); // still reports whether the state matched
      const sql = `UPDATE credentials SET ${sets.map(([c]) => `${c} = ?`).join(', ')} WHERE ${where.join(' AND ')}`;
      return (await changes(db.prepare(sql).bind(...sets.map(([, v]) => v), ...args))) === 1;
    },

    async listRenewalCandidates(opts) {
      const { results } = await db
        .prepare(
          `SELECT u.*, c.* FROM users u JOIN credentials c ON c.user_id = u.id
           WHERE (c.session_enc IS NOT NULL
                  AND MAX(COALESCE(c.session_ok_at, 0), COALESCE(c.session_tried_at, 0)) <= ?)
              OR (c.session_enc IS NULL AND c.status = 'active' AND c.private_token_enc IS NOT NULL
                  AND (c.autologin_at IS NULL OR c.autologin_at <= ? OR c.autologin_at < c.connected_at))
           ORDER BY CASE WHEN c.session_enc IS NOT NULL
                         THEN MAX(COALESCE(c.session_ok_at, 0), COALESCE(c.session_tried_at, 0)) + ?
                         ELSE COALESCE(c.autologin_at, 0) + ? END ASC, u.id ASC
           LIMIT ?`,
        )
        .bind(
          opts.sessionBefore,
          opts.autologinBefore,
          opts.sessionIdleMs,
          opts.autologinRetryMs,
          Math.max(1, Math.floor(opts.limit)),
        )
        .all<UserRaw & CredentialRaw>();
      return results.map((r) => ({ user: toUser(r), credential: toCredential(r) }));
    },
  };
}
