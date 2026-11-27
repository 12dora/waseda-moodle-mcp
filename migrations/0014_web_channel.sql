-- Round 14: the Moodle web-session channel. Waseda Moodle switched the mobile web service off, so a credential may now
-- hold a web session without any app token: token_enc, token_hash and token_hint become NULLable (NULL = no token).
-- SQLite cannot drop NOT NULL, so the table is rebuilt; nothing references credentials, so dropping the old one
-- cascades nowhere. Rows are copied as they are: stored web sessions keep working without a reconnect.
-- sesskey_enc: the sesskey of the stored session, encrypted like the token; NULL = read from a page when first needed.
CREATE TABLE credentials_new (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_enc         TEXT,
  private_token_enc TEXT,
  token_hash        TEXT,
  token_hint        TEXT,
  status            TEXT    NOT NULL CHECK (status IN ('active', 'invalid')),
  connected_via     TEXT    NOT NULL,
  connected_at      INTEGER NOT NULL,
  last_ok_at        INTEGER,
  last_error        TEXT,
  session_enc       TEXT,
  session_ok_at     INTEGER,
  session_tried_at  INTEGER,
  renewed_at        INTEGER,
  autologin_at      INTEGER,
  sesskey_enc       TEXT
);
INSERT INTO credentials_new (user_id, token_enc, private_token_enc, token_hash, token_hint, status, connected_via,
  connected_at, last_ok_at, last_error, session_enc, session_ok_at, session_tried_at, renewed_at, autologin_at)
SELECT user_id, token_enc, private_token_enc, token_hash, token_hint, status, connected_via,
  connected_at, last_ok_at, last_error, session_enc, session_ok_at, session_tried_at, renewed_at, autologin_at
FROM credentials;
DROP TABLE credentials;
ALTER TABLE credentials_new RENAME TO credentials;

-- Facts about the Moodle site that every request needs. 'mobile_service': '1' while the mobile web service is on
-- (checked by the cron against tool_mobile_get_public_config, set to '0' by a request that finds it off). It is off
-- today.
CREATE TABLE site_state (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO site_state (key, value, updated_at)
VALUES ('mobile_service', '0', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
