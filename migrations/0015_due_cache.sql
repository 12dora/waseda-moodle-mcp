-- Round 14: the console's due list answers at once. GET /api/due returns the copy stored for the same query and the
-- console then asks again with ?refresh=1, which computes the list (cached course sweep) and replaces the copy.
-- query: the normalised request options (days / overdue_days / course_id). body: the DueList JSON as answered.
-- created_at: when that answer was computed (epoch ms). The daily purge deletes copies older than 7 days; deleting
-- the account deletes them too.
CREATE TABLE IF NOT EXISTS due_cache (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, query)
);
CREATE INDEX IF NOT EXISTS idx_due_cache_created ON due_cache (created_at);
