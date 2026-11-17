CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_days INTEGER NOT NULL CHECK(duration_days > 0),
  traffic_gb REAL NOT NULL DEFAULT 0 CHECK(traffic_gb >= 0),
  speed_limit_mbps INTEGER NOT NULL DEFAULT 0 CHECK(speed_limit_mbps >= 0),
  device_limit INTEGER NOT NULL DEFAULT 0 CHECK(device_limit >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE plan_groups (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(plan_id, group_id),
  UNIQUE(plan_id, position)
);
CREATE INDEX plan_groups_group_id ON plan_groups(group_id);
CREATE TABLE user_entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  source TEXT NOT NULL CHECK(source IN ('admin', 'trial')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(expires_at > starts_at)
);
CREATE UNIQUE INDEX user_entitlements_active ON user_entitlements(user_id) WHERE status = 'active';
CREATE INDEX user_entitlements_user ON user_entitlements(user_id, created_at);
INSERT INTO system_settings(key, value, updated_at) VALUES
  ('trial_plan_id', 'null', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('trial_days', 'null', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
