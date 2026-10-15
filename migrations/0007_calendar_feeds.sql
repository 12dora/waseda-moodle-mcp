-- Round 8 (§17.2): one secret ICS calendar URL per user (`/cal/<token>.ics`). Only the SHA-256 of the token is stored
-- (the token is shown once); rotating replaces the row, revoking deletes it. cache_ics holds the last rendered feed for
-- 30 minutes (calendar apps poll), cache_at when it was rendered.
CREATE TABLE calendar_feeds (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT    NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_fetch_at INTEGER,
  cache_ics     TEXT,
  cache_at      INTEGER
);
