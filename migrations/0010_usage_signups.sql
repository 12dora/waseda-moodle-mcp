-- Retention denominators: anonymous signup counts per JST signup week ('w:<Monday>', metric 'signups'), from now on
-- bumped when an account is created and kept when it is deleted. This backfills the accounts that exist today.
-- JST Monday: shift to JST, back 6 days, then forward to the next Monday (or stay on it).
INSERT INTO usage_counts (period, metric, dim, value)
SELECT 'w:' || strftime('%Y-%m-%d', (created_at + 32400000) / 1000, 'unixepoch', '-6 days', 'weekday 1'), 'signups', '',
       COUNT(*)
FROM users WHERE true
GROUP BY 1
ON CONFLICT(period, metric, dim) DO UPDATE SET value = MAX(value, excluded.value);
