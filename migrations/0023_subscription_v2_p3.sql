CREATE TABLE IF NOT EXISTS redemption_batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template_version_id TEXT NOT NULL REFERENCES entitlement_template_versions(id),
  template_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 500),
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  redeem_deadline INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  note TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_key TEXT NOT NULL,
  UNIQUE (created_by, request_key)
);
CREATE INDEX IF NOT EXISTS redemption_batches_created ON redemption_batches(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS redemption_batches_version ON redemption_batches(template_version_id);

CREATE TABLE IF NOT EXISTS redemption_codes (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES redemption_batches(id),
  digest_key_version TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  tail TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND max_uses),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  UNIQUE (digest_key_version, code_digest)
);
CREATE INDEX IF NOT EXISTS redemption_codes_batch ON redemption_codes(batch_id, id);

-- Preserve the receipt and issuance ID when the subscription is deleted.
CREATE TABLE IF NOT EXISTS redemption_records (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES redemption_codes(id),
  user_id TEXT NOT NULL,
  subscription_id TEXT UNIQUE REFERENCES subscriptions(id) ON DELETE SET NULL,
  issued_subscription_id TEXT NOT NULL UNIQUE,
  subscription_name TEXT NOT NULL,
  expires_at INTEGER,
  redeemed_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  replay_verifier TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key),
  UNIQUE (code_id, user_id)
);
CREATE INDEX IF NOT EXISTS redemption_records_created ON redemption_records(redeemed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS redemption_records_user ON redemption_records(user_id, redeemed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS redemption_audit_target ON audit_logs(target_type, target_id, created_at DESC, id DESC)
  WHERE target_type = 'redemption_batches';

-- Keep dynamic groups available for outstanding codes even after a template edit.
CREATE TRIGGER IF NOT EXISTS redemption_group_in_use
BEFORE DELETE ON groups
WHEN EXISTS (
  SELECT 1 FROM redemption_batches b
  JOIN entitlement_template_versions v ON v.id = b.template_version_id
  JOIN json_each(v.config_json, '$.groupIds') selected
  WHERE selected.value = OLD.id AND b.enabled = 1
    AND b.redeem_deadline > unixepoch('subsec') * 1000
    AND EXISTS (SELECT 1 FROM redemption_codes c
      WHERE c.batch_id = b.id AND c.revoked = 0 AND c.used_count < c.max_uses)
)
BEGIN
  SELECT RAISE(ABORT, 'REDEMPTION_GROUP_IN_USE');
END;
