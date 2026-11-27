-- Run before cutover against a stable source snapshot. Rehearse on a copy and
-- compare the validation counts below before enabling readers. The old
-- resolver grants nodes only for enabled templates, including on import. IDs prefixed
-- with migration: are reserved for these imports.
WITH latest AS (
  SELECT v.* FROM entitlement_template_versions v
  WHERE v.version_no = (
    SELECT max(other.version_no) FROM entitlement_template_versions other WHERE other.template_id = v.template_id
  )
)
INSERT INTO plan_definitions (
  id, name, description, remark, duration_seconds, enabled, archived_at,
  owner_user_id, source_type, source_id, version, created_at, updated_at
)
SELECT 'migration:template:' || t.id, t.name, t.description,
  json_object('allow_redemption', t.allow_redemption,
    'template_version_id', v.id,
    'direct_node_ids', json_extract(v.config_json, '$.nodeIds'),
    'old_quota_bytes', json_extract(v.config_json, '$.quotaBytes'),
    'old_speed_limit_mbps', json_extract(v.config_json, '$.limits.speedLimitMbps')),
  json_extract(v.config_json, '$.duration.value') * CASE json_extract(v.config_json, '$.duration.unit')
    WHEN 'day' THEN 86400 WHEN 'week' THEN 604800 WHEN 'month' THEN 2592000 WHEN 'year' THEN 31536000
    ELSE 0 END,
  t.status = 'enabled', CASE WHEN t.status = 'archived' THEN t.updated_at END,
  p.owner_user_id, 'template', t.id, t.revision, t.created_at, t.updated_at
FROM entitlement_templates t
JOIN latest v ON v.template_id = t.id AND v.schema_version = 1
LEFT JOIN private_entitlement_templates p ON p.template_id = t.id
WHERE json_type(v.config_json, '$.duration.value') = 'integer'
ON CONFLICT (source_type, source_id) DO NOTHING;

INSERT INTO plan_definitions (
  id, name, description, remark, duration_seconds, enabled, source_type, source_id, created_at, updated_at
)
SELECT 'migration:legacy-plan:' || id, name, description,
  json_object('old_traffic_gb', traffic_gb, 'old_speed_limit_mbps', speed_limit_mbps,
    'old_device_limit', device_limit, 'old_sort_order', sort_order),
  duration_days * 86400, enabled, 'legacy_plan', id, created_at, updated_at
FROM plans WHERE true
ON CONFLICT (source_type, source_id) DO NOTHING;

-- Direct node selections are retained verbatim in remark.direct_node_ids for
-- pre-cutover reconciliation. They must be materialized as group membership
-- before enabling any plan reader that would otherwise lose those nodes.
INSERT INTO plan_node_groups (plan_id, group_id)
SELECT p.id, g.id
FROM plan_definitions p
JOIN entitlement_template_versions v ON v.id = json_extract(p.remark, '$.template_version_id')
JOIN json_each(v.config_json, '$.groupIds') selected
JOIN groups g ON g.id = selected.value
WHERE p.source_type = 'template'
ON CONFLICT (plan_id, group_id) DO NOTHING;

INSERT INTO plan_node_groups (plan_id, group_id)
SELECT p.id, pg.group_id FROM plan_groups pg
JOIN plan_definitions p ON p.source_type = 'legacy_plan' AND p.source_id = pg.plan_id
WHERE true
ON CONFLICT (plan_id, group_id) DO NOTHING;

INSERT INTO user_plans (
  id, user_id, plan_id, starts_at, expires_at, status, source, source_id, version, created_at, updated_at
)
SELECT 'migration:binding:' || json_array(b.user_id, b.template_id), b.user_id, p.id,
  b.starts_at, b.expires_at, b.status, 'migration', json_array(b.user_id, b.template_id),
  b.revision, b.created_at, b.updated_at
FROM user_template_bindings b
JOIN plan_definitions p ON p.source_type = 'template' AND p.source_id = b.template_id
WHERE true
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscription_tokens (id, scope, user_id, token_digest, token_ciphertext, revoked_at, created_at)
SELECT 'migration:access:' || user_id, 'aggregate', user_id, token_hash, encrypted_token,
  CASE WHEN enabled = 0 THEN updated_at END, created_at
FROM user_subscription_access WHERE true
ON CONFLICT (id) DO NOTHING;

WITH batches AS (
  SELECT b.*, coalesce(b.template_id, v.template_id) AS source_template_id,
    coalesce(b.duration_json, json_extract(v.config_json, '$.duration')) AS duration
  FROM redemption_batches b
  JOIN entitlement_template_versions v ON v.id = b.template_version_id
)
INSERT INTO redeem_codes (
  id, code_digest, digest_key_version, tail, plan_id, duration_mode, duration_seconds,
  valid_until, max_uses, used_count, per_user_limit, enabled, remark, batch_id
)
SELECT 'migration:code:' || c.id, c.code_digest, c.digest_key_version, c.tail, p.id, 'fixed',
  json_extract(b.duration, '$.value') * CASE json_extract(b.duration, '$.unit')
    WHEN 'day' THEN 86400 WHEN 'week' THEN 604800 WHEN 'month' THEN 2592000 WHEN 'year' THEN 31536000
    ELSE 0 END,
  b.redeem_deadline, c.max_uses, c.used_count, 1, b.enabled AND c.revoked = 0, b.note, b.id
FROM redemption_codes c
JOIN batches b ON b.id = c.batch_id
JOIN plan_definitions p ON p.source_type = 'template' AND p.source_id = b.source_template_id
WHERE json_type(b.duration, '$.value') = 'integer'
ON CONFLICT (id) DO NOTHING;

-- Live legacy subscriptions are absent from the production inventory.
-- Archived subscriptions and all their old group links are excluded from
-- entitlement mapping. Only receipt provenance is imported for legacy issues.
INSERT INTO redemptions (id, code_id, user_id, redeemed_at, request_id, issued_subscription_id)
SELECT 'migration:legacy-receipt:' || r.id, c.id, r.user_id, r.redeemed_at, r.idempotency_key, r.issued_subscription_id
FROM redemption_records r JOIN redeem_codes c ON c.id = 'migration:code:' || r.code_id
WHERE true
ON CONFLICT (id) DO NOTHING;

-- A mutable legacy binding can have several receipts. Associate its current
-- instance with the latest receipt only and preserve the other receipts.
WITH receipts AS (
  SELECT r.*,
    row_number() OVER (PARTITION BY user_id, template_id ORDER BY redeemed_at DESC, id DESC) AS receipt_rank
  FROM binding_redemption_records r
)
INSERT INTO redemptions (id, code_id, user_id, user_plan_id, redeemed_at, request_id)
SELECT 'migration:binding-receipt:' || r.id, c.id, r.user_id,
  CASE WHEN r.receipt_rank = 1 THEN p.id END, r.redeemed_at, r.idempotency_key
FROM receipts r
JOIN redeem_codes c ON c.id = 'migration:code:' || r.code_id
LEFT JOIN user_plans p ON p.id = 'migration:binding:' || json_array(r.user_id, r.template_id)
WHERE true
ON CONFLICT (id) DO NOTHING;

-- Reconciliation (run individually before/after on the rehearsal database).
-- SELECT (SELECT count(*) FROM entitlement_templates) AS source, count(*) AS imported FROM plan_definitions WHERE source_type = 'template';
-- SELECT (SELECT count(*) FROM plans) AS source, count(*) AS imported FROM plan_definitions WHERE source_type = 'legacy_plan';
-- SELECT (SELECT count(*) FROM user_template_bindings) AS source, count(*) AS imported FROM user_plans WHERE source = 'migration';
-- SELECT (SELECT count(*) FROM user_subscription_access) AS source, count(*) AS imported FROM subscription_tokens WHERE id GLOB 'migration:access:*';
-- SELECT (SELECT count(*) FROM redemption_codes) AS source, count(*) AS imported FROM redeem_codes WHERE id GLOB 'migration:code:*';
-- SELECT (SELECT count(*) FROM redemption_records) + (SELECT count(*) FROM binding_redemption_records) AS source, count(*) AS imported FROM redemptions WHERE id GLOB 'migration:*-receipt:*';
-- SELECT count(*) AS unmapped_template_groups FROM plan_definitions p JOIN entitlement_template_versions v ON v.id = json_extract(p.remark, '$.template_version_id') JOIN json_each(v.config_json, '$.groupIds') g WHERE p.source_type = 'template' AND NOT EXISTS (SELECT 1 FROM plan_node_groups pg WHERE pg.plan_id = p.id AND pg.group_id = g.value);
-- SELECT count(*) AS unmapped_legacy_plan_groups FROM plan_groups g WHERE NOT EXISTS (SELECT 1 FROM plan_definitions p JOIN plan_node_groups pg ON pg.plan_id = p.id WHERE p.source_type = 'legacy_plan' AND p.source_id = g.plan_id AND pg.group_id = g.group_id);
-- SELECT p.id, n.value AS direct_node_id FROM plan_definitions p JOIN json_each(p.remark, '$.direct_node_ids') n WHERE p.source_type = 'template';
-- SELECT count(*) AS excluded_legacy_group_links FROM subscription_groups;
-- SELECT count(*) AS archived_subscriptions FROM legacy_subscriptions_archive; -- production-shaped databases only
-- SELECT count(*) AS binding_receipts_without_instance FROM redemptions WHERE id GLOB 'migration:binding-receipt:*' AND user_plan_id IS NULL;
-- SELECT count(*) AS tokens_without_ciphertext FROM subscription_tokens WHERE id GLOB 'migration:access:*' AND token_ciphertext IS NULL;
-- SELECT count(*) AS unsupported_policy_links FROM entitlement_plan_policies;
-- PRAGMA foreign_key_check;
-- Preflight for source anomalies that can prevent a faithful import.
-- SELECT count(*) AS templates_without_supported_latest_version FROM entitlement_templates t WHERE NOT EXISTS (SELECT 1 FROM entitlement_template_versions v WHERE v.template_id = t.id AND v.schema_version = 1 AND v.version_no = (SELECT max(x.version_no) FROM entitlement_template_versions x WHERE x.template_id = t.id) AND json_type(v.config_json, '$.duration.value') = 'integer');
-- SELECT count(*) AS legacy_receipts_without_user FROM redemption_records r WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id);
-- SELECT count(*) AS overlapping_receipt_requests FROM redemption_records r JOIN binding_redemption_records b ON b.user_id = r.user_id AND b.idempotency_key = r.idempotency_key;
-- SELECT count(*) AS direct_nodes_missing FROM plan_definitions p JOIN json_each(p.remark, '$.direct_node_ids') n WHERE p.source_type = 'template' AND NOT EXISTS (SELECT 1 FROM nodes WHERE id = n.value);
