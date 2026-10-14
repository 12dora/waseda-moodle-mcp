-- Round 1 review: pending OAuth authorize requests and our own rate-limit counters (KV is reserved for the OAuth library).

-- Pending OAuth authorization requests (parsed by /authorize, approved on the consent page). Encrypted, 10 min TTL.
CREATE TABLE oauth_requests (
  id          TEXT    PRIMARY KEY,
  payload_enc TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_oauth_requests_expires ON oauth_requests(expires_at);

-- Fixed-window abuse counters (KV is reserved for the OAuth library: Free KV allows only 1000 writes/day).
CREATE TABLE rate_limits (
  key          TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
