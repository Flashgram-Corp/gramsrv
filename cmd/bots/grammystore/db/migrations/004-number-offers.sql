-- Sell-your-own-number buyback offers: a user suggests a +7/+1 number, the
-- admin prices it, the user confirms, and the store compensates them in Stars.
CREATE TABLE IF NOT EXISTS number_offers (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  phone TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  price INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  priced_at BIGINT NOT NULL DEFAULT 0,
  resolved_at BIGINT NOT NULL DEFAULT 0
);

-- Only one unresolved offer per phone.
CREATE UNIQUE INDEX IF NOT EXISTS number_offers_active_idx ON number_offers(phone) WHERE status IN ('pending', 'priced');