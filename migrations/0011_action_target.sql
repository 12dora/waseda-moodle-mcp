-- What a write action changes in Moodle ("<kind>:<ids>", services/actions/target.ts); NULL = cannot conflict.
-- Rival actions of one user and target: only one that was pending at the same time may run, the others are
-- 'superseded'. Existing rows keep NULL (no backfill): they are finished or expire within 30 minutes.
ALTER TABLE actions ADD COLUMN target TEXT;
CREATE INDEX IF NOT EXISTS idx_actions_target ON actions (user_id, target, status);
