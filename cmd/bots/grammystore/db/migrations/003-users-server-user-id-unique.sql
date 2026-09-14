-- Enforce a single Telegram user per connected {product} account.
-- A positive server_user_id can be claimed by only one user. The migration
-- fails if the current data already duplicates an ID, which must be resolved
-- first (unbind/de-duplicate the affected users).
CREATE UNIQUE INDEX IF NOT EXISTS users_server_user_id_uq ON users(server_user_id) WHERE server_user_id > 0;