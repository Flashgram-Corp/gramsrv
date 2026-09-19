BEGIN;
ALTER TABLE processed_payments ADD COLUMN IF NOT EXISTS provider_charge_id TEXT NOT NULL DEFAULT '';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS provider_charge_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS sales_provider_charge_id_idx ON sales(provider_charge_id);
COMMIT;