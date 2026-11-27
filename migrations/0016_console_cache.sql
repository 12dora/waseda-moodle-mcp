-- Round 14: every Moodle-backed console GET answers at once (generalises 0015's due_cache). GET /api/due,
-- /api/courses, /api/courses/overview, /api/timetable, /api/updates and /api/syllabus return the copy stored for the
-- same request and the console then asks again with ?refresh=1, which computes the answer and replaces the copy.
-- cache_key: `<route>?<normalised query>` (e.g. /api/due?days=14&overdue_days=&course_id=). body: the JSON as
-- answered. created_at: when that answer was computed (epoch ms). The daily purge deletes copies older than 7 days;
-- a console write that changes these answers (course selection, schedule overrides, reconnect, approved action)
-- deletes the user's copies; deleting the account deletes them too.
ALTER TABLE due_cache RENAME TO console_cache;
ALTER TABLE console_cache RENAME COLUMN query TO cache_key;
-- 0015's keys were the bare due-list query
UPDATE console_cache SET cache_key = '/api/due?' || cache_key;
DROP INDEX IF EXISTS idx_due_cache_created;
CREATE INDEX IF NOT EXISTS idx_console_cache_created ON console_cache (created_at);
