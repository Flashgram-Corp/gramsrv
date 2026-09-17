-- Wheel awards need a stable per-spin identity. The historical primary key
-- (telegram_id, day) reserved a single slot per user per UTC day, and the store
-- treated any finished award for today as "daily spin limit reached" — so a
-- daily limit above 1 or 0 (unlimited) was impossible. Awards now carry their
-- own spin_key used by reserve/finish and by the grant idempotency key
-- (spin:<user>:<spin_key>): an interrupted grant is resumed on the exact same
-- award, and limits can allow more than one spin per day.
-- Backfill: the old primary key guaranteed at most one day per user, so deriving
-- the spin_key from day is collision-free per telegram_id.
ALTER TABLE spin_awards ADD COLUMN IF NOT EXISTS spin_key TEXT;
UPDATE spin_awards SET spin_key = 'legacy-' || day WHERE spin_key IS NULL;
ALTER TABLE spin_awards ALTER COLUMN spin_key SET NOT NULL;
ALTER TABLE spin_awards DROP CONSTRAINT IF EXISTS spin_awards_pkey;
ALTER TABLE spin_awards ADD CONSTRAINT spin_awards_pkey PRIMARY KEY (telegram_id, spin_key);
CREATE INDEX IF NOT EXISTS spin_awards_day_idx ON spin_awards (telegram_id, day);
CREATE INDEX IF NOT EXISTS spin_awards_week_idx ON spin_awards (telegram_id, week);