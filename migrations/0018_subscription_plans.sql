ALTER TABLE subscriptions ADD COLUMN plan_id TEXT REFERENCES plans(id) ON DELETE RESTRICT;
ALTER TABLE subscriptions ADD COLUMN traffic_gb REAL NOT NULL DEFAULT 0 CHECK (traffic_gb >= 0);
ALTER TABLE subscriptions ADD COLUMN speed_limit_mbps INTEGER NOT NULL DEFAULT 0 CHECK (speed_limit_mbps >= 0);
ALTER TABLE subscriptions ADD COLUMN device_limit INTEGER NOT NULL DEFAULT 0 CHECK (device_limit >= 0);
ALTER TABLE subscriptions ADD COLUMN plan_source TEXT CHECK (plan_source IN ('admin', 'trial'));
ALTER TABLE subscriptions ADD COLUMN plan_note TEXT NOT NULL DEFAULT '';
ALTER TABLE subscriptions ADD COLUMN plan_revoked INTEGER NOT NULL DEFAULT 0 CHECK (plan_revoked IN (0, 1));
ALTER TABLE subscriptions ADD COLUMN last_reminded_at INTEGER;
CREATE INDEX subscriptions_plan_id ON subscriptions(plan_id);

-- Existing links shared the owner's effective entitlement. Map the active
-- record, or latest revoked record, to every owned subscription. Preserve
-- older history in separate disabled subscriptions with the original window.
CREATE TABLE subscription_plan_migration (
  legacy_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL UNIQUE,
  previous_starts_at INTEGER,
  previous_expires_at INTEGER,
  previous_enabled INTEGER
);

INSERT INTO subscription_plan_migration
WITH ranked AS (
  SELECT e.*, row_number() OVER (
    PARTITION BY user_id ORDER BY (status = 'active') DESC, created_at DESC, rowid DESC
  ) AS preference
  FROM user_entitlements e
)
SELECT e.id, coalesce(s.id, 'sub_' || (
  max(
    coalesce((SELECT max(cast(substr(id, 5) AS INTEGER)) FROM subscriptions), 0),
    coalesce((SELECT cast(value AS INTEGER) - 1 FROM system_settings WHERE key = 'next_subscription_id'), 0)
  ) + row_number() OVER (ORDER BY e.user_id, e.preference, s.id)
)), s.starts_at, s.expires_at, s.enabled
FROM ranked e LEFT JOIN subscriptions s ON e.preference = 1 AND s.user_id = e.user_id;

UPDATE subscriptions AS s
SET (plan_id, traffic_gb, speed_limit_mbps, device_limit, plan_source, plan_note,
     plan_revoked, last_reminded_at, starts_at, expires_at, enabled) = (
  SELECT e.plan_id, p.traffic_gb, p.speed_limit_mbps, p.device_limit, e.source, e.note,
    e.status = 'revoked', e.last_reminded_at,
    min(
      cast(round((julianday(e.expires_at) - 2440587.5) * 86400000) AS INTEGER),
      max(
        cast(round((julianday(e.starts_at) - 2440587.5) * 86400000) AS INTEGER),
        coalesce(s.starts_at, cast(round((julianday(s.created_at) - 2440587.5) * 86400000) AS INTEGER), 0)
      )
    ),
    cast(round((julianday(e.expires_at) - 2440587.5) * 86400000) AS INTEGER),
    s.enabled AND e.status = 'active'
  FROM subscription_plan_migration m
  JOIN user_entitlements e ON e.id = m.legacy_id JOIN plans p ON p.id = e.plan_id
  WHERE m.subscription_id = s.id
), revision = revision + 1
WHERE id IN (SELECT subscription_id FROM subscription_plan_migration WHERE previous_enabled IS NOT NULL);

-- The SQL migration cannot access the KV encryption key. These rows have
-- no usable bearer credential until the authenticated subscription view
-- generates one with the normal token encryption routine.
INSERT INTO subscriptions (
  id, user_id, name, token_hash, token_prefix, encrypted_token, enabled, default_client, revision,
  starts_at, expires_at, created_at, updated_at, plan_id, traffic_gb, speed_limit_mbps,
  device_limit, plan_source, plan_note, plan_revoked, last_reminded_at
)
SELECT m.subscription_id, e.user_id, substr(p.name, 1, 128),
  lower(hex(randomblob(21))) || 'A', 'pending_', '{}', e.status = 'active', 'mihomo', 1,
  cast(round((julianday(e.starts_at) - 2440587.5) * 86400000) AS INTEGER),
  cast(round((julianday(e.expires_at) - 2440587.5) * 86400000) AS INTEGER),
  e.created_at, e.updated_at, e.plan_id, p.traffic_gb, p.speed_limit_mbps,
  p.device_limit, e.source, e.note, e.status = 'revoked', e.last_reminded_at
FROM subscription_plan_migration m JOIN user_entitlements e ON e.id = m.legacy_id
JOIN plans p ON p.id = e.plan_id WHERE m.previous_enabled IS NULL;

INSERT INTO subscription_groups (subscription_id, group_id, position)
SELECT m.subscription_id, pg.group_id, pg.position
FROM subscription_plan_migration m JOIN user_entitlements e ON e.id = m.legacy_id
JOIN plan_groups pg ON pg.plan_id = e.plan_id WHERE m.previous_enabled IS NULL;

INSERT INTO system_settings (key, value, updated_at)
SELECT 'next_subscription_id', max(cast(substr(subscription_id, 5) AS INTEGER)) + 1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM subscription_plan_migration WHERE previous_enabled IS NULL HAVING count(*) > 0
ON CONFLICT(key) DO UPDATE SET value = max(cast(value AS INTEGER), cast(excluded.value AS INTEGER)),
  updated_at=excluded.updated_at;

INSERT INTO system_settings (key, value, updated_at)
SELECT 'delivery_revision', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM subscription_plan_migration)
ON CONFLICT(key) DO UPDATE SET value=cast(value AS INTEGER)+1, updated_at=excluded.updated_at;

ALTER TABLE user_entitlements RENAME TO user_entitlements_legacy;
