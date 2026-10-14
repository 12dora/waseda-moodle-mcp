-- Waseda Moodle MCP: initial schema (D1 / SQLite).
-- Times are unix milliseconds (INTEGER). JSON documents are stored as TEXT.
-- Every table that belongs to a user cascades on user deletion.

CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  moodle_user_id INTEGER NOT NULL UNIQUE,
  fullname       TEXT    NOT NULL,
  lang           TEXT    NOT NULL DEFAULT 'en',
  settings       TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER
);

CREATE TABLE credentials (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_enc         TEXT    NOT NULL,
  private_token_enc TEXT,
  token_hash        TEXT    NOT NULL,
  token_hint        TEXT    NOT NULL,
  status            TEXT    NOT NULL CHECK (status IN ('active', 'invalid')),
  connected_via     TEXT    NOT NULL,
  connected_at      INTEGER NOT NULL,
  last_ok_at        INTEGER,
  last_error        TEXT
);

CREATE TABLE sessions (
  id_hash      TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE api_keys (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  prefix       TEXT    NOT NULL,
  key_hash     TEXT    NOT NULL UNIQUE,
  scopes       TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id, created_at);

CREATE TABLE actions (
  id          TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  approval    TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  details     TEXT    NOT NULL,
  warnings    TEXT    NOT NULL,
  payload     TEXT    NOT NULL,
  source      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  executed_at INTEGER,
  result      TEXT,
  error       TEXT
);
CREATE INDEX idx_actions_user ON actions(user_id, created_at);
CREATE INDEX idx_actions_status ON actions(status, expires_at);

CREATE TABLE upload_drafts (
  id            TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cmid          INTEGER NOT NULL,
  draft_item_id INTEGER NOT NULL,
  files         TEXT    NOT NULL,
  total_bytes   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_upload_drafts_user ON upload_drafts(user_id);
CREATE INDEX idx_upload_drafts_expires ON upload_drafts(expires_at);

CREATE TABLE course_index (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id  INTEGER NOT NULL,
  json       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, course_id)
);
CREATE INDEX idx_course_index_updated ON course_index(updated_at);

CREATE TABLE audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at      INTEGER NOT NULL,
  actor   TEXT    NOT NULL,
  action  TEXT    NOT NULL,
  detail  TEXT
);
CREATE INDEX idx_audit_user_at ON audit(user_id, at);
CREATE INDEX idx_audit_at ON audit(at);

-- Short-lived, single-use hand-off of a Moodle launch payload (bookmarklet / extension -> console). Not user-owned.
CREATE TABLE handoffs (
  code_hash   TEXT    PRIMARY KEY,
  payload_enc TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_handoffs_expires ON handoffs(expires_at);
