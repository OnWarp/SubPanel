-- groups is the existing node_groups model. group_sources, group_nodes and
-- group_node_order implement membership and ordering. Reuse audit_logs.
CREATE TABLE IF NOT EXISTS plan_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  remark TEXT,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR (typeof(duration_seconds) = 'integer' AND duration_seconds > 0)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  archived_at TEXT,
  owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  source_type TEXT CHECK (source_type IN ('template', 'legacy_plan')),
  source_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((source_type IS NULL) = (source_id IS NULL)),
  UNIQUE (source_type, source_id)
);

CREATE TABLE IF NOT EXISTS plan_node_groups (
  plan_id TEXT NOT NULL REFERENCES plan_definitions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, group_id)
);
CREATE INDEX IF NOT EXISTS plan_node_groups_group ON plan_node_groups(group_id);

CREATE TABLE IF NOT EXISTS user_plans (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plan_definitions(id) ON DELETE RESTRICT,
  starts_at INTEGER NOT NULL CHECK (typeof(starts_at) = 'integer'),
  expires_at INTEGER CHECK (expires_at IS NULL OR (typeof(expires_at) = 'integer' AND expires_at > starts_at)),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  source TEXT NOT NULL CHECK (source IN ('admin', 'redeem', 'manual', 'migration', 'trial')),
  source_id TEXT,
  remark TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version > 0),
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS user_plans_user_status_expiry ON user_plans(user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS user_plans_plan ON user_plans(plan_id);

CREATE TABLE IF NOT EXISTS subscription_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('aggregate', 'package')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  user_plan_id TEXT,
  token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 43 AND token_digest NOT GLOB '*[^A-Za-z0-9_-]*'),
  token_ciphertext TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((scope = 'aggregate') = (user_plan_id IS NULL)),
  FOREIGN KEY (user_plan_id, user_id) REFERENCES user_plans(id, user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_tokens_active_aggregate
  ON subscription_tokens(user_id) WHERE scope = 'aggregate' AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subscription_tokens_active_package
  ON subscription_tokens(user_plan_id) WHERE scope = 'package' AND revoked_at IS NULL AND user_plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscription_tokens_user ON subscription_tokens(user_id, id);
CREATE INDEX IF NOT EXISTS subscription_tokens_instance ON subscription_tokens(user_plan_id, id);

CREATE TABLE IF NOT EXISTS redeem_codes (
  id TEXT PRIMARY KEY NOT NULL,
  code_digest TEXT NOT NULL,
  digest_key_version TEXT NOT NULL,
  tail TEXT NOT NULL CHECK (length(tail) = 4),
  plan_id TEXT NOT NULL REFERENCES plan_definitions(id) ON DELETE RESTRICT,
  duration_mode TEXT NOT NULL CHECK (duration_mode IN ('plan_default', 'fixed', 'permanent')),
  duration_seconds INTEGER,
  valid_from INTEGER CHECK (valid_from IS NULL OR typeof(valid_from) = 'integer'),
  valid_until INTEGER CHECK (valid_until IS NULL OR typeof(valid_until) = 'integer'),
  max_uses INTEGER NOT NULL CHECK (typeof(max_uses) = 'integer' AND max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(used_count) = 'integer' AND used_count BETWEEN 0 AND max_uses),
  per_user_limit INTEGER NOT NULL DEFAULT 1 CHECK (typeof(per_user_limit) = 'integer' AND per_user_limit > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  remark TEXT,
  batch_id TEXT,
  CHECK ((duration_mode = 'fixed' AND typeof(duration_seconds) = 'integer' AND duration_seconds > 0)
    OR (duration_mode <> 'fixed' AND duration_seconds IS NULL)),
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from),
  UNIQUE (digest_key_version, code_digest)
);
CREATE INDEX IF NOT EXISTS redeem_codes_plan ON redeem_codes(plan_id, id);

CREATE TABLE IF NOT EXISTS redemptions (
  id TEXT PRIMARY KEY NOT NULL,
  code_id TEXT NOT NULL REFERENCES redeem_codes(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  user_plan_id TEXT UNIQUE,
  redeemed_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  issued_subscription_id TEXT,
  FOREIGN KEY (user_plan_id, user_id) REFERENCES user_plans(id, user_id) ON DELETE RESTRICT,
  UNIQUE (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS redemptions_code_user ON redemptions(code_id, user_id);

-- Each alias targets precisely one user (aggregate) or one instance (package).
-- The future compatibility reader must enforce revocation and exact scope.
CREATE TABLE IF NOT EXISTS legacy_subscription_routes (
  legacy_token_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(legacy_token_digest) = 43 AND legacy_token_digest NOT GLOB '*[^A-Za-z0-9_-]*'),
  target_scope TEXT NOT NULL CHECK (target_scope IN ('aggregate', 'package')),
  target_id TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS legacy_subscription_routes_target ON legacy_subscription_routes(target_scope, target_id);
