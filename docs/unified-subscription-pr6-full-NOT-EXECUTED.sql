-- PR6 full contraction | NOT EXECUTED IN PRODUCTION
-- Baseline c57d6778d, schema through 0028. Execute as a single atomic D1 batch.
-- Keep foreign keys enabled. The approved cutover waives the 90-day wait.
-- A populated legacy template or dependent conversion object aborts the batch.
-- See unified-subscription-pr6-full-rollback.md for recovery.

CREATE TABLE pr6_contract_guard (
  ready INTEGER NOT NULL CHECK (ready = 1)
);

INSERT INTO pr6_contract_guard (ready)
SELECT
  (SELECT count(*) FROM system_settings
    WHERE key IN ('unified_subscription_ready', 'unified_subscription_public_ready')
      AND value = 'true') = 2
  AND NOT EXISTS (
    SELECT 1 FROM compile_jobs WHERE status IN ('queued', 'running')
  )
  AND NOT EXISTS (SELECT 1 FROM subscription_templates)
  AND NOT EXISTS (SELECT 1 FROM subscription_template_versions)
  AND NOT EXISTS (SELECT 1 FROM subscription_template_default WHERE template_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM subscription_template_bindings)
  AND NOT EXISTS (SELECT 1 FROM conversion_profiles)
  AND NOT EXISTS (SELECT 1 FROM conversion_profile_versions)
  AND NOT EXISTS (SELECT 1 FROM conversion_bindings)
  AND NOT EXISTS (SELECT 1 FROM conversion_rule_version_snapshots);

-- Preserve the complete legacy parent before changing any child FK.
CREATE TABLE legacy_subscriptions_archive (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  encrypted_token TEXT NOT NULL CHECK (json_type(encrypted_token) = 'object'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  default_client TEXT NOT NULL CHECK (default_client IN (
    'mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'
  )),
  revision INTEGER NOT NULL CHECK (revision > 0),
  starts_at INTEGER,
  expires_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  plan_id TEXT REFERENCES plans(id) ON DELETE RESTRICT,
  traffic_gb REAL NOT NULL DEFAULT 0 CHECK (traffic_gb >= 0),
  speed_limit_mbps INTEGER NOT NULL DEFAULT 0 CHECK (speed_limit_mbps >= 0),
  device_limit INTEGER NOT NULL DEFAULT 0 CHECK (device_limit >= 0),
  plan_source TEXT CHECK (plan_source IN ('admin', 'trial')),
  plan_note TEXT NOT NULL DEFAULT '',
  plan_revoked INTEGER NOT NULL DEFAULT 0 CHECK (plan_revoked IN (0, 1)),
  last_reminded_at INTEGER,
  CHECK (starts_at IS NULL OR expires_at IS NULL OR starts_at <= expires_at)
);
INSERT INTO legacy_subscriptions_archive (id, user_id, name, token_hash, token_prefix, encrypted_token, enabled, default_client, revision, starts_at, expires_at, created_at, updated_at, plan_id,
  traffic_gb,
  speed_limit_mbps,
  device_limit,
  plan_source,
  plan_note,
  plan_revoked,
  last_reminded_at)
SELECT id, user_id, name, token_hash, token_prefix, encrypted_token, enabled, default_client, revision, starts_at, expires_at, created_at, updated_at, plan_id,
  traffic_gb,
  speed_limit_mbps,
  device_limit,
  plan_source,
  plan_note,
  plan_revoked,
  last_reminded_at FROM subscriptions;
CREATE INDEX legacy_subscriptions_archive_enabled ON legacy_subscriptions_archive(enabled);
CREATE INDEX legacy_subscriptions_archive_plan_id ON legacy_subscriptions_archive(plan_id);
CREATE UNIQUE INDEX legacy_subscriptions_archive_token_hash ON legacy_subscriptions_archive(token_hash);
CREATE INDEX legacy_subscriptions_archive_user_id ON legacy_subscriptions_archive(user_id);

-- Retire triggers whose writes belong to the old issuance/backfill paths.
DROP TRIGGER unified_subscription_checkpoint_guard;
DROP TRIGGER subscription_batch_item_audit;
DROP TRIGGER entitlement_origin_can_issue;
DROP TRIGGER private_entitlement_legacy_origin;
DROP TRIGGER subscription_node_enabled;
-- Temporarily remove objects that read a table during its rebuild.
DROP VIEW all_redemption_records;
DROP TRIGGER entitlement_group_in_use;

CREATE TABLE redemption_records_pr6_next (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES redemption_codes(id),
  user_id TEXT NOT NULL,
  subscription_id TEXT UNIQUE REFERENCES legacy_subscriptions_archive(id) ON DELETE SET NULL,
  issued_subscription_id TEXT NOT NULL UNIQUE,
  subscription_name TEXT NOT NULL,
  expires_at INTEGER,
  redeemed_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  replay_verifier TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key),
  UNIQUE (code_id, user_id)
);
INSERT INTO redemption_records_pr6_next (id, code_id, user_id, subscription_id, issued_subscription_id, subscription_name, expires_at, redeemed_at, idempotency_key, replay_verifier)
SELECT id, code_id, user_id, subscription_id, issued_subscription_id, subscription_name, expires_at, redeemed_at, idempotency_key, replay_verifier FROM redemption_records;
DROP TABLE redemption_records;
ALTER TABLE redemption_records_pr6_next RENAME TO redemption_records;
CREATE INDEX redemption_records_created ON redemption_records(redeemed_at DESC, id DESC);
CREATE INDEX redemption_records_user ON redemption_records(user_id, redeemed_at DESC, id DESC);

CREATE TABLE subscription_creation_pr6_next (
  subscription_id TEXT UNIQUE REFERENCES legacy_subscriptions_archive(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'legacy')),
  request_key_hash TEXT UNIQUE,
  request_fingerprint TEXT,
  CHECK ((request_key_hash IS NULL) = (request_fingerprint IS NULL))
);
INSERT INTO subscription_creation_pr6_next (subscription_id, source_type, request_key_hash, request_fingerprint)
SELECT subscription_id, source_type, request_key_hash, request_fingerprint FROM subscription_creation;
DROP TABLE subscription_creation;
ALTER TABLE subscription_creation_pr6_next RENAME TO subscription_creation;

CREATE TABLE unified_subscription_mappings_pr6_next (
  legacy_subscription_id TEXT PRIMARY KEY REFERENCES legacy_subscriptions_archive(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL UNIQUE REFERENCES entitlement_templates(id) ON DELETE RESTRICT,
  source_revision INTEGER NOT NULL,
  source_token_hash TEXT NOT NULL,
  original_node_ids TEXT NOT NULL CHECK (json_type(original_node_ids)='array'),
  status TEXT NOT NULL CHECK (status='backfilled'),
  created_at TEXT NOT NULL
);
INSERT INTO unified_subscription_mappings_pr6_next (legacy_subscription_id, user_id, template_id, source_revision, source_token_hash, original_node_ids, status, created_at)
SELECT legacy_subscription_id, user_id, template_id, source_revision, source_token_hash, original_node_ids, status, created_at FROM unified_subscription_mappings;
DROP TABLE unified_subscription_mappings;
ALTER TABLE unified_subscription_mappings_pr6_next RENAME TO unified_subscription_mappings;
CREATE INDEX unified_subscription_mapping_user ON unified_subscription_mappings(user_id);

CREATE TABLE subscription_template_origins_pr6_next (
  subscription_id TEXT PRIMARY KEY REFERENCES legacy_subscriptions_archive(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES entitlement_template_versions(id) ON DELETE RESTRICT
);
INSERT INTO subscription_template_origins_pr6_next (subscription_id, version_id)
SELECT subscription_id, version_id FROM subscription_template_origins;
DROP TABLE subscription_template_origins;
ALTER TABLE subscription_template_origins_pr6_next RENAME TO subscription_template_origins;
CREATE INDEX idx_subscription_template_origins_version ON subscription_template_origins(version_id);

CREATE TABLE subscription_nodes_pr6_next (
  subscription_id TEXT NOT NULL REFERENCES legacy_subscriptions_archive(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (subscription_id, node_id)
);
INSERT INTO subscription_nodes_pr6_next (subscription_id, node_id, position)
SELECT subscription_id, node_id, position FROM subscription_nodes;
DROP TABLE subscription_nodes;
ALTER TABLE subscription_nodes_pr6_next RENAME TO subscription_nodes;
CREATE INDEX idx_subscription_nodes_node ON subscription_nodes(node_id);

CREATE TABLE subscription_groups_pr6_next (
  subscription_id TEXT NOT NULL REFERENCES legacy_subscriptions_archive(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (subscription_id, group_id)
);
INSERT INTO subscription_groups_pr6_next (subscription_id, group_id, position)
SELECT subscription_id, group_id, position FROM subscription_groups;
DROP TABLE subscription_groups;
ALTER TABLE subscription_groups_pr6_next RENAME TO subscription_groups;
CREATE INDEX subscription_groups_compile_group ON subscription_groups(group_id, subscription_id);
CREATE INDEX subscription_groups_group_id ON subscription_groups(group_id);
CREATE UNIQUE INDEX subscription_groups_position ON subscription_groups(subscription_id, position);

-- Restore shared receipt and entitlement protections.
CREATE VIEW all_redemption_records AS
  SELECT r.*, v.template_id, NULL AS previous_expires_at FROM redemption_records r
    JOIN redemption_codes c ON c.id=r.code_id
    JOIN redemption_batches b ON b.id=c.batch_id
    JOIN entitlement_template_versions v ON v.id=b.template_version_id
  UNION ALL
  SELECT id,code_id,user_id,NULL,NULL,subscription_name,expires_at,redeemed_at,idempotency_key,
    replay_verifier,template_id,previous_expires_at FROM binding_redemption_records;
CREATE TRIGGER entitlement_group_in_use
BEFORE DELETE ON groups
WHEN EXISTS (SELECT 1 FROM subscription_groups WHERE group_id = OLD.id)
  OR EXISTS (
    SELECT 1 FROM entitlement_templates t
    JOIN entitlement_template_versions v ON v.template_id = t.id
      AND v.version_no = (SELECT max(version_no) FROM entitlement_template_versions WHERE template_id = t.id)
    JOIN json_each(v.config_json, '$.groupIds') AS selected
    WHERE t.status <> 'archived' AND selected.value = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_GROUP_IN_USE');
END;

-- All six inbound FK edges now target the archive. Retire the business table last.
DROP TABLE subscriptions;
-- Retire the empty conversion objects tied to legacy templates.
-- Standalone rule source and local rule-set storage is retained.
DROP VIEW conversion_effective_bindings;
DROP VIEW conversion_profile_outputs;
DROP VIEW conversion_profile_catalog;
DROP TRIGGER conversion_link_version;
DROP TRIGGER conversion_link_template;
DROP TABLE conversion_bindings;
DROP TABLE conversion_profile_versions;
DROP TABLE conversion_profiles;
DROP TABLE conversion_rule_version_snapshots;
DROP TABLE subscription_template_bindings;
DROP TABLE subscription_template_default;
DROP TABLE subscription_template_versions;
DROP TABLE subscription_templates;

DROP TABLE pr6_contract_guard;
