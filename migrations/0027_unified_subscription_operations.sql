-- Legacy issuance versions and receipts remain readable during rollout.
ALTER TABLE redemption_batches ADD COLUMN template_id TEXT REFERENCES entitlement_templates(id);
ALTER TABLE redemption_batches ADD COLUMN duration_json TEXT CHECK (duration_json IS NULL OR json_valid(duration_json));

CREATE TABLE binding_redemption_records (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES redemption_codes(id),
  user_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  subscription_name TEXT NOT NULL,
  previous_expires_at INTEGER,
  expires_at INTEGER,
  redeemed_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  replay_verifier TEXT NOT NULL,
  FOREIGN KEY (user_id, template_id) REFERENCES user_template_bindings(user_id, template_id),
  UNIQUE (code_id, user_id),
  UNIQUE (user_id, idempotency_key)
);

CREATE VIEW all_redemption_records AS
  SELECT r.*, v.template_id, NULL AS previous_expires_at FROM redemption_records r
    JOIN redemption_codes c ON c.id=r.code_id
    JOIN redemption_batches b ON b.id=c.batch_id
    JOIN entitlement_template_versions v ON v.id=b.template_version_id
  UNION ALL
  SELECT id,code_id,user_id,NULL,NULL,subscription_name,expires_at,redeemed_at,idempotency_key,
    replay_verifier,template_id,previous_expires_at FROM binding_redemption_records;

CREATE TABLE entitlement_plan_policies (
  template_id TEXT PRIMARY KEY REFERENCES entitlement_templates(id),
  plan_id TEXT UNIQUE NOT NULL REFERENCES plans(id) ON DELETE RESTRICT
);

CREATE TABLE user_subscription_reminders (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE user_subscription_shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  template_id TEXT REFERENCES entitlement_templates(id),
  token_hash TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);
CREATE INDEX unified_shares_owner ON user_subscription_shares(user_id,id);

CREATE INDEX binding_active_windows ON user_template_bindings(user_id,starts_at,expires_at) WHERE status='active';
