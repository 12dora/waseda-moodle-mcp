-- Round 7 review: the course ids (JSON array, sorted) of the user's last interactive scope. The scheduled sweep has no
-- calendar signal and reads cached syllabus rows only, so it also sweeps these courses; written only when the list changes.
ALTER TABLE users ADD COLUMN scope_course_ids TEXT;
