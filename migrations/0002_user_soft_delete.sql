-- Batch 8: soft delete for users. deleted_at is NULL while the account is
-- active and holds the deletion timestamp while it sits in the recycle bin.
ALTER TABLE users ADD COLUMN deleted_at TEXT;

CREATE INDEX users_deleted_at ON users(deleted_at);
