-- Round 11: automatic credential renewal. Moodle mobile tokens expire after about a week; a Moodle web session
-- (opened with the private token via autologin, kept alive by the cron) fetches the current token from launch.php.
-- session_enc: the encrypted MoodleSession cookie (same AES-GCM key as the token); NULL = no session.
-- session_ok_at: when launch.php last answered with a token for it. renewed_at: when a new token was stored by renewal.
-- session_tried_at: the last launch.php attempt with the session that failed (rotation: a failing session waits its
-- turn instead of taking every run). autologin_at: the last attempt to open a session (stamped before it; spaces out
-- retries after a refusal).
ALTER TABLE credentials ADD COLUMN session_enc TEXT;
ALTER TABLE credentials ADD COLUMN session_ok_at INTEGER;
ALTER TABLE credentials ADD COLUMN session_tried_at INTEGER;
ALTER TABLE credentials ADD COLUMN renewed_at INTEGER;
ALTER TABLE credentials ADD COLUMN autologin_at INTEGER;
