-- Mail access approval: a user applies before connecting the Waseda mailbox and an operator (ADMIN_MOODLE_USERIDS)
-- decides. Google's user slots are limited (migrations/0012_mail.sql), approval keeps use fair. Operators need no row.
-- decided_by: the deciding operator's Moodle user id.
CREATE TABLE IF NOT EXISTS mail_access (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mail_access_status ON mail_access (status, requested_at);

-- users who connected before approvals existed keep their access
INSERT OR IGNORE INTO mail_access (user_id, status, requested_at, decided_at, decided_by)
  SELECT user_id, 'approved', connected_at, connected_at, NULL FROM mail_credentials;
