-- Round 2 review: the scheduled sweep queue orders users by when they were last attempted (stamped even on failure or an
-- empty scope), not by their oldest snapshot, so a few users with stale out-of-scope snapshots cannot starve the rest.
ALTER TABLE users ADD COLUMN last_swept_at INTEGER;
