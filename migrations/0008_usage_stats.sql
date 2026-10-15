-- Aggregate usage counters (no user ids). period: 'd:YYYY-MM-DD' | 'w:YYYY-MM-DD' (Monday) | 'm:YYYY-MM' (JST).
CREATE TABLE usage_counts (
  period TEXT    NOT NULL,
  metric TEXT    NOT NULL,
  dim    TEXT    NOT NULL DEFAULT '',
  value  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period, metric, dim)
) WITHOUT ROWID;

-- Same-period de-duplication of active users: key = HMAC-SHA-256(period salt, "<userId>|<client>") truncated, hex.
-- Rows and salts are deleted once their period has ended.
CREATE TABLE usage_seen (
  period TEXT NOT NULL,
  key    TEXT NOT NULL,
  PRIMARY KEY (period, key)
) WITHOUT ROWID;

CREATE TABLE usage_salts (
  period TEXT PRIMARY KEY,
  salt   TEXT NOT NULL
);
