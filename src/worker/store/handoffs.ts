interface HandoffRow {
  codeHash: string;
  payloadEnc: string;
  createdAt: number;
  expiresAt: number;
}

export interface HandoffMethods {
  putHandoff(row: HandoffRow): Promise<void>;
  /** Atomically removes the row (single use) and returns its payload unless it has expired. */
  takeHandoff(codeHash: string, now: number): Promise<string | null>;
}

export function handoffMethods(db: D1Database): HandoffMethods {
  return {
    async putHandoff(row) {
      await db
        .prepare('INSERT INTO handoffs (code_hash, payload_enc, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(row.codeHash, row.payloadEnc, row.createdAt, row.expiresAt)
        .run();
    },

    async takeHandoff(codeHash, now) {
      const r = await db
        .prepare('DELETE FROM handoffs WHERE code_hash = ? RETURNING payload_enc, expires_at')
        .bind(codeHash)
        .first<{ payload_enc: string; expires_at: number }>();
      return r && r.expires_at > now ? r.payload_enc : null;
    },
  };
}
