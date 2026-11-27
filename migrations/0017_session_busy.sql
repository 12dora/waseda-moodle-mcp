-- Round 14 (incident 2026-11-27): Moodle serialises the requests of one web session, and a request we gave up on (our
-- 25 s timeout) keeps running there, so every request sent meanwhile queues behind it and times out as well; with the
-- console's cards and the hourly cron on top this kept one user's session timing out for over 10 minutes.
-- busy_until: epoch ms; a web-session request ran out of time, so the session counts as busy until then (now + 120 s).
-- Meanwhile console reads answer their stored copy (or moodle_busy), MCP tools fail fast with moodle_busy, and the
-- keepalive and the course sweep leave the user out. The next request Moodle answers clears it. NULL = not busy.
-- session_used_at: epoch ms; a console or MCP request last used the web session (written at most once a minute;
-- background work never writes it). The course sweep leaves out users whose session was used in the last minutes, so
-- it does not queue behind a console page load.
ALTER TABLE credentials ADD COLUMN busy_until INTEGER;
ALTER TABLE credentials ADD COLUMN session_used_at INTEGER;
