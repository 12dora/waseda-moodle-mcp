/** Short-lived rows that belong to no user: pending OAuth authorization requests and rate-limit counters. */

export interface EphemeralMethods {
  putOAuthRequest(row: { id: string; payloadEnc: string; createdAt: number; expiresAt: number }): Promise<void>;
  /** Non-destructive read; null when unknown or expired. */
  getOAuthRequest(id: string, now: number): Promise<string | null>;
  /** Atomic single-use read: removes the row, returns the payload unless it has expired. */
  takeOAuthRequest(id: string, now: number): Promise<string | null>;
  /** Fixed-window counter: registers one hit and returns the hits in the current window (including this one). */
  hitRateLimit(key: string, windowMs: number, now: number): Promise<number>;
}

export function ephemeralMethods(db: D1Database): EphemeralMethods {
  return {
    async putOAuthRequest(row) {
      await db
        .prepare('INSERT INTO oauth_requests (id, payload_enc, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(row.id, row.payloadEnc, row.createdAt, row.expiresAt)
        .run();
    },

    async getOAuthRequest(id, now) {
      const r = await db
        .prepare('SELECT payload_enc FROM oauth_requests WHERE id = ? AND expires_at > ?')
        .bind(id, now)
        .first<{ payload_enc: string }>();
      return r?.payload_enc ?? null;
    },

    async takeOAuthRequest(id, now) {
      const r = await db
        .prepare('DELETE FROM oauth_requests WHERE id = ? RETURNING payload_enc, expires_at')
        .bind(id)
        .first<{ payload_enc: string; expires_at: number }>();
      return r && r.expires_at > now ? r.payload_enc : null;
    },

    async hitRateLimit(key, windowMs, now) {
      const staleBefore = now - windowMs;
      const r = await db
        .prepare(
          `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT(key) DO UPDATE SET
             count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
             window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
           RETURNING count`,
        )
        .bind(key, now, staleBefore, staleBefore, now)
        .first<{ count: number }>();
      return r?.count ?? 1;
    },
  };
}
