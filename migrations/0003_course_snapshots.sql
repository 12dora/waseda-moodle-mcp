-- Round 2: compact per-course content snapshots (sweep, "what's new", search) replace the round-1 search index.
-- The old index payload has a different shape and is rebuilt on demand, so its rows are not carried over.
DROP TABLE course_index;

CREATE TABLE course_snapshots (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id  INTEGER NOT NULL,
  json       TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL, -- last full core_course_get_contents
  checked_at INTEGER NOT NULL, -- last update check (core_course_get_updates_since) or fetch
  PRIMARY KEY (user_id, course_id)
);
CREATE INDEX idx_course_snapshots_checked ON course_snapshots(checked_at);

-- Public syllabus lookups (term / weekday-period / instructors), shared by all users and keyed by the Moodle course
-- idnumber. json is the lookup result, or the text "null" for "no syllabus found" (negative answers are cached too).
CREATE TABLE syllabus_cache (
  idnumber   TEXT    PRIMARY KEY,
  json       TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX idx_syllabus_cache_fetched ON syllabus_cache(fetched_at);
