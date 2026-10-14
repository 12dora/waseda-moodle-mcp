import type { ApiKeyRow, SessionRow, Store, UserRow } from '../../core/context';
import type { Scope } from '../../core/types';
import { changes, parseJson, toJson } from './rows';
import { toUser, type UserRaw } from './users';

interface SessionRaw {
  id_hash: string;
  user_id: number;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
}

interface ApiKeyRaw {
  id: string;
  user_id: number;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const toSession = (r: SessionRaw): SessionRow => ({
  idHash: r.id_hash,
  userId: r.user_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastSeenAt: r.last_seen_at,
  userAgent: r.user_agent,
});

const toApiKey = (r: ApiKeyRaw): ApiKeyRow => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  prefix: r.prefix,
  keyHash: r.key_hash,
  scopes: parseJson<Scope[]>(r.scopes, []),
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

type SessionMethods = Pick<
  Store,
  'createSession' | 'getSession' | 'touchSession' | 'deleteSession' | 'deleteUserSessions'
> & {
  /** One round trip for the hot path: the session row and its user. */
  getSessionWithUser(idHash: string): Promise<{ session: SessionRow; user: UserRow } | null>;
};

export function sessionMethods(db: D1Database): SessionMethods {
  return {
    async createSession(row) {
      await db
        .prepare(
          'INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(row.idHash, row.userId, row.createdAt, row.expiresAt, row.lastSeenAt, row.userAgent ?? null)
        .run();
    },

    async getSession(idHash) {
      const r = await db.prepare('SELECT * FROM sessions WHERE id_hash = ?').bind(idHash).first<SessionRaw>();
      return r ? toSession(r) : null;
    },

    async getSessionWithUser(idHash) {
      const found = await db
        .prepare(
          `SELECT s.id_hash, s.user_id, s.created_at, s.expires_at, s.last_seen_at, s.user_agent,
                  u.id AS u_id, u.moodle_user_id AS u_moodle_user_id, u.fullname AS u_fullname, u.lang AS u_lang,
                  u.settings AS u_settings, u.created_at AS u_created_at, u.last_seen_at AS u_last_seen_at
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
        )
        .bind(idHash)
        .first<SessionRaw & Record<`u_${string}`, unknown>>();
      if (!found) return null;
      const user: UserRaw = {
        id: found.u_id as number,
        moodle_user_id: found.u_moodle_user_id as number,
        fullname: found.u_fullname as string,
        lang: found.u_lang as string,
        settings: found.u_settings as string,
        created_at: found.u_created_at as number,
        last_seen_at: (found.u_last_seen_at as number | null) ?? null,
      };
      return { session: toSession(found), user: toUser(user) };
    },

    async touchSession(idHash, at, expiresAt) {
      await db
        .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?')
        .bind(at, expiresAt, idHash)
        .run();
    },

    async deleteSession(idHash) {
      await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run();
    },

    async deleteUserSessions(userId) {
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
    },
  };
}

type ApiKeyMethods = Pick<Store, 'createApiKey' | 'listApiKeys' | 'getApiKeyByHash' | 'revokeApiKey' | 'touchApiKey'>;

export function apiKeyMethods(db: D1Database): ApiKeyMethods {
  return {
    async createApiKey(row) {
      await db
        .prepare(
          `INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at, last_used_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.userId,
          row.name,
          row.prefix,
          row.keyHash,
          toJson(row.scopes),
          row.createdAt,
          row.lastUsedAt ?? null,
          row.revokedAt ?? null,
        )
        .run();
    },

    async listApiKeys(userId) {
      const { results } = await db
        .prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC, id DESC')
        .bind(userId)
        .all<ApiKeyRaw>();
      return results.map(toApiKey);
    },

    async getApiKeyByHash(keyHash) {
      const r = await db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').bind(keyHash).first<ApiKeyRaw>();
      return r ? toApiKey(r) : null;
    },

    async revokeApiKey(userId, id, at) {
      const n = await changes(
        db
          .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
          .bind(at, id, userId),
      );
      return n > 0;
    },

    async touchApiKey(id, at) {
      await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(at, id).run();
    },
  };
}
