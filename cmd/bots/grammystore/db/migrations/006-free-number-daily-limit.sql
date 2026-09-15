-- Daily limit for free number changes. The value is a count of free number
-- allocations per user per UTC day, controlled by the admin through the prices
-- panel (`free N` line, 0 = unlimited). The counter lives on the user row so a
-- re-roll cannot be counted away by releasing the previous free number.
ALTER TABLE users ADD COLUMN IF NOT EXISTS free_day TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS free_day_count INTEGER NOT NULL DEFAULT 0;