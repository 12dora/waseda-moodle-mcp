-- Round 7: weekly class times inferred from the attendance sessions a user sees in Moodle (per user, 7-day cache).
-- json = { slots, firstDate, lastDate } (InferredSchedule without checkedAt); an empty slot list is cached too, so a
-- course without recurring attendance sessions is not asked again on every call.
CREATE TABLE inferred_schedules (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id  INTEGER NOT NULL,
  json       TEXT    NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, course_id)
);
CREATE INDEX idx_inferred_schedules_checked ON inferred_schedules(checked_at);
