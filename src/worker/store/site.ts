/** Facts about the Moodle site that belong to no user (site_state, migration 0014). */

export interface SiteMethods {
  getSiteState(key: string): Promise<string | null>;
  putSiteState(key: string, value: string, at: number): Promise<void>;
}

export function siteMethods(db: D1Database): SiteMethods {
  return {
    async getSiteState(key) {
      const r = await db.prepare('SELECT value FROM site_state WHERE key = ?').bind(key).first<{ value: string }>();
      return r?.value ?? null;
    },

    async putSiteState(key, value, at) {
      await db
        .prepare(
          `INSERT INTO site_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(key, value, at)
        .run();
    },
  };
}
