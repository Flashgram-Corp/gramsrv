-- Supports the admin console's "accounts sharing a device" report, which
-- groups authorizations by (device_model, system_version, platform, ip) and
-- looks for groups spanning more than one distinct user_id. Without this
-- index that GROUP BY is a full sequential scan of authorizations, a table
-- that grows roughly with active-session count and is never pruned except on
-- explicit revoke.

CREATE INDEX idx_authorizations_device_fingerprint
  ON public.authorizations (device_model, system_version, platform, ip)
  WHERE device_model <> '';