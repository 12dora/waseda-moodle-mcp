/** Migration 0014 on real SQLite: stored connections survive the table rebuild, token columns accept NULL. */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createD1Store, type D1Store } from '../../src/worker/store-d1';
import { createTestD1, type TestD1 } from '../helpers/d1-sqlite';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

function migrate(t: TestD1, pick: (name: string) => boolean): void {
  const names = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && pick(n));
  for (const name of names.sort()) t.sqlite.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
}

const OLD_COLUMNS = `user_id, token_enc, private_token_enc, token_hash, token_hint, status, connected_via,
  connected_at, last_ok_at, last_error, session_enc, session_ok_at, session_tried_at, renewed_at, autologin_at`;

let t: TestD1;
let store: D1Store;
let before: unknown[];

const rows = () => t.sqlite.prepare(`SELECT ${OLD_COLUMNS} FROM credentials ORDER BY user_id`).all();

beforeEach(() => {
  t = createTestD1(false);
  migrate(t, (name) => name < '0014');
  const user = t.sqlite.prepare(
    `INSERT INTO users (id, moodle_user_id, fullname, lang, settings, created_at)
     VALUES (?, ?, 'U', 'en', '{}', 1)`,
  );
  for (const id of [1, 2, 3]) user.run(id, 7000 + id);
  const insert = t.sqlite.prepare(`INSERT INTO credentials (${OLD_COLUMNS}) VALUES (${'?,'.repeat(14)}?)`);
  insert.run(1, 'tok1', 'priv1', 'h1', 'aaaa', 'active', 'bookmarklet', 10, 20, null, 'cookie1', 30, 31, 32, 33);
  insert.run(2, 'tok2', null, 'h2', 'bbbb', 'invalid', 'paste', 11, null, 'expired', 'cookie2', 40, null, null, null);
  before = rows();
  migrate(t, (name) => name >= '0014');
  store = createD1Store(t.db);
});

describe('migration 0014', () => {
  it('keeps every stored row as it was, sessions included', async () => {
    expect(rows()).toEqual(before);
    expect(await store.getCredential(1)).toMatchObject({
      tokenEnc: 'tok1',
      sessionEnc: 'cookie1',
      sessionOkAt: 30,
      sesskeyEnc: null,
      connectedVia: 'bookmarklet',
    });
    const due = await store.listRenewalCandidates({ visitedBefore: 100, limit: 10 });
    expect(due.map((c) => c.user.id)).toEqual([1, 2]);
  });

  it('accepts a connection without any app token', async () => {
    await store.putCredential({
      userId: 3,
      tokenEnc: null,
      privateTokenEnc: null,
      tokenHash: null,
      tokenHint: null,
      status: 'active',
      connectedVia: 'extension',
      connectedAt: 50,
      lastOkAt: 50,
      lastError: null,
    });
    await store.updateCredentialStatus(3, { sessionEnc: 'cookie3', sesskeyEnc: 'key3' });
    expect(await store.getCredential(3)).toMatchObject({
      tokenEnc: null,
      tokenHash: null,
      tokenHint: null,
      sessionEnc: 'cookie3',
      sesskeyEnc: 'key3',
    });
    expect(await store.updateCredentialIf(3, { tokenHash: null, sessionEnc: 'cookie3' }, { lastOkAt: 60 })).toBe(true);
  });

  it('keeps the status check and the cascade from users', async () => {
    expect(() => t.sqlite.exec("UPDATE credentials SET status = 'other' WHERE user_id = 1")).toThrow();
    t.sqlite.exec('DELETE FROM users WHERE id = 1');
    expect(await store.getCredential(1)).toBeNull();
    const orphan = `INSERT INTO credentials (user_id, status, connected_via, connected_at)
      VALUES (99, 'active', 'paste', 1)`;
    expect(() => t.sqlite.exec(orphan)).toThrow(); // the reference to users is still enforced
  });

  it('starts with the mobile web service off', async () => {
    expect(await store.getSiteState('mobile_service')).toBe('0');
    const row = t.sqlite.prepare("SELECT updated_at FROM site_state WHERE key = 'mobile_service'").get();
    expect(Number(row?.updated_at)).toBeGreaterThan(Date.UTC(2026, 0, 1));
    await store.putSiteState('mobile_service', '1', 99);
    expect(await store.getSiteState('mobile_service')).toBe('1');
    expect(await store.getSiteState('other')).toBeNull();
  });
});
