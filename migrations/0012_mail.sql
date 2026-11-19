-- Waseda mailbox (Google Workspace Gmail) connection, optional and one per user (services/mail).
-- refresh_enc: the Google refresh token, AES-GCM like credentials.token_enc; NULL once revoked (idle cleanup), the row
-- then only explains why the connection ended. scopes: granted Google scopes, space separated. google_sub: the Google
-- account id (id_token `sub`): a reconnect with the same account must never revoke (Google's revoke ends the app's
-- whole grant for that account, the stored token included). idle_tried_at: the idle cleanup's last failed attempt (such
-- rows go behind the others).
CREATE TABLE IF NOT EXISTS mail_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  google_sub TEXT,
  refresh_enc TEXT,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'invalid')),
  connected_at INTEGER NOT NULL,
  last_used_at INTEGER,
  last_error TEXT,
  idle_tried_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mail_credentials_idle ON mail_credentials (status, last_used_at);

-- Mail slots: Moodle users who ever connected a mailbox. Google caps an unverified app at 100 users over the project's
-- lifetime (revoking does not give a slot back), so a slot is kept after a disconnect or an account deletion and a
-- returning user reuses it. Holds nothing but the Moodle user id.
CREATE TABLE IF NOT EXISTS mail_slots (
  moodle_user_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL
);
