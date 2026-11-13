-- Batch 8: soft delete for users. deleted_at is NULL while the account is
-- active and holds the deletion timestamp while it sits in the recycle bin.
ALTER TABLE users ADD COLUMN deleted_at TEXT;

CREATE INDEX users_deleted_at ON users(deleted_at);

-- Plain PATCH role semantics (integration reconciliation): administrators
-- are no longer a singleton, so the 0001 single-admin unique index goes.
DROP INDEX users_single_admin;
