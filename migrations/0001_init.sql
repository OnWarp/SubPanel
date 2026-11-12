-- SubPanel D1 foundation. Field mapping: docs/d1/SCHEMA.md
-- KV remains the production store. This migration only creates tables.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  password_algorithm TEXT NOT NULL CHECK (password_algorithm = 'PBKDF2-SHA-256'),
  password_iterations INTEGER NOT NULL CHECK (password_iterations > 0),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL CHECK (session_version >= 0),
  email TEXT,
  email_normalized TEXT,
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX users_username ON users(username);
CREATE UNIQUE INDEX users_email_normalized ON users(email_normalized) WHERE email_normalized IS NOT NULL;
CREATE UNIQUE INDEX users_single_admin ON users(role) WHERE role = 'admin';

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX invitations_user_id ON invitations(user_id);
CREATE INDEX invitations_username ON invitations(username);
CREATE INDEX invitations_expires_at ON invitations(expires_at);

CREATE TABLE invitation_redemptions (
  id INTEGER PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES invitations(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  redeemed_at TEXT NOT NULL
);

CREATE UNIQUE INDEX invitation_redemptions_invitation ON invitation_redemptions(invitation_id);
CREATE INDEX invitation_redemptions_user_id ON invitation_redemptions(user_id);

CREATE TABLE email_verifications (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX email_verifications_token_hash ON email_verifications(token_hash);
CREATE INDEX email_verifications_user_id ON email_verifications(user_id);
CREATE INDEX email_verifications_email_normalized ON email_verifications(email_normalized);

CREATE TABLE email_change_requests (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_email_normalized TEXT,
  new_email TEXT NOT NULL,
  new_email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX email_change_requests_token_hash ON email_change_requests(token_hash);
CREATE INDEX email_change_requests_user_id ON email_change_requests(user_id);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY CHECK (length(key) > 0),
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
);

CREATE TABLE allowed_email_domains (
  domain TEXT PRIMARY KEY CHECK (length(domain) > 0 AND domain = lower(domain)),
  created_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  expires_at INTEGER,
  PRIMARY KEY (bucket, subject, window_start)
);

CREATE INDEX rate_limits_expires_at ON rate_limits(expires_at);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('manual', 'file', 'remote')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  encrypted_content TEXT CHECK (encrypted_content IS NULL OR json_type(encrypted_content) = 'object'),
  encrypted_url TEXT CHECK (encrypted_url IS NULL OR json_type(encrypted_url) = 'object'),
  encrypted_headers TEXT CHECK (encrypted_headers IS NULL OR json_type(encrypted_headers) = 'object'),
  refresh_interval_minutes INTEGER,
  detected_format TEXT CHECK (
    detected_format IS NULL OR detected_format IN (
      'uri-list', 'base64-uri-list', 'mihomo', 'sing-box', 'sip008', 'loon', 'surge',
      'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'mixed'
    )
  ),
  warnings TEXT NOT NULL CHECK (json_type(warnings) = 'array'),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    refresh_interval_minutes IS NULL
    OR (refresh_interval_minutes > 0 AND refresh_interval_minutes % 15 = 0)
  ),
  CHECK (
    (
      type = 'remote'
      AND encrypted_url IS NOT NULL
      AND encrypted_headers IS NOT NULL
      AND refresh_interval_minutes IS NOT NULL
    )
    OR (
      type IN ('manual', 'file')
      AND encrypted_url IS NULL
      AND encrypted_headers IS NULL
      AND refresh_interval_minutes IS NULL
    )
  )
);

CREATE INDEX sources_type_enabled ON sources(type, enabled);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL CHECK (protocol IN (
    'shadowsocks', 'ss2022', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2',
    'tuic', 'wireguard', 'anytls', 'naive', 'snell', 'shadowtls', 'http', 'https', 'socks5'
  )),
  display_name TEXT NOT NULL,
  server TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  credentials TEXT NOT NULL CHECK (json_type(credentials) = 'object'),
  tls TEXT CHECK (tls IS NULL OR json_type(tls) = 'object'),
  transport TEXT CHECK (transport IS NULL OR json_type(transport) = 'object'),
  plugin TEXT CHECK (plugin IS NULL OR json_type(plugin) = 'object'),
  extensions TEXT NOT NULL CHECK (json_type(extensions) = 'object'),
  fingerprint TEXT NOT NULL,
  source_ids TEXT NOT NULL CHECK (json_type(source_ids) = 'array'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  retained INTEGER NOT NULL CHECK (retained IN (0, 1)),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX nodes_fingerprint ON nodes(fingerprint);
CREATE INDEX nodes_enabled ON nodes(enabled);

CREATE TABLE node_raw_variants (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN (
    'uri-list', 'base64-uri-list', 'mihomo', 'sing-box', 'sip008', 'loon', 'surge',
    'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'mixed'
  )),
  raw TEXT NOT NULL,
  extensions TEXT NOT NULL CHECK (json_type(extensions) = 'object')
);

CREATE INDEX node_raw_variants_node_id ON node_raw_variants(node_id);
CREATE INDEX node_raw_variants_source_id ON node_raw_variants(source_id);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE group_sources (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (group_id, source_id)
);

CREATE UNIQUE INDEX group_sources_position ON group_sources(group_id, position);
CREATE INDEX group_sources_source_id ON group_sources(source_id);

CREATE TABLE group_nodes (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('included', 'excluded')),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (group_id, node_id)
);

CREATE UNIQUE INDEX group_nodes_position ON group_nodes(group_id, relation, position);
CREATE INDEX group_nodes_node_id ON group_nodes(node_id);

CREATE TABLE group_node_order (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (group_id, node_id)
);

CREATE UNIQUE INDEX group_node_order_position ON group_node_order(group_id, position);
CREATE INDEX group_node_order_node_id ON group_node_order(node_id);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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
  CHECK (starts_at IS NULL OR expires_at IS NULL OR starts_at <= expires_at)
);

CREATE UNIQUE INDEX subscriptions_token_hash ON subscriptions(token_hash);
CREATE INDEX subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX subscriptions_enabled ON subscriptions(enabled);

CREATE TABLE subscription_groups (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (subscription_id, group_id)
);

CREATE UNIQUE INDEX subscription_groups_position ON subscription_groups(subscription_id, position);
CREATE INDEX subscription_groups_group_id ON subscription_groups(group_id);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  official_website TEXT NOT NULL,
  developer TEXT,
  is_recommended INTEGER NOT NULL CHECK (is_recommended IN (0, 1)),
  is_official INTEGER NOT NULL CHECK (is_official IN (0, 1)),
  is_popular INTEGER NOT NULL CHECK (is_popular IN (0, 1)),
  is_enabled INTEGER NOT NULL CHECK (is_enabled IN (0, 1)),
  is_public INTEGER NOT NULL CHECK (is_public IN (0, 1)),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX apps_sort_order ON apps(sort_order);
CREATE INDEX apps_public_enabled ON apps(is_public, is_enabled);

CREATE TABLE app_platforms (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'windows', 'macos', 'linux')),
  version TEXT NOT NULL,
  download_url TEXT NOT NULL,
  download_type TEXT NOT NULL,
  file_size_kb INTEGER CHECK (file_size_kb IS NULL OR file_size_kb >= 0),
  official_store_url TEXT NOT NULL,
  official_download_url TEXT NOT NULL,
  update_notes TEXT NOT NULL,
  import_supported INTEGER NOT NULL CHECK (import_supported IN (0, 1)),
  import_protocol TEXT NOT NULL,
  import_url_template TEXT NOT NULL,
  import_instructions TEXT NOT NULL,
  is_enabled INTEGER NOT NULL CHECK (is_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX app_platforms_app_id ON app_platforms(app_id);
CREATE INDEX app_platforms_platform ON app_platforms(platform);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_encrypted TEXT NOT NULL CHECK (json_type(token_encrypted) = 'object'),
  remark TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('none', 'password')),
  access_password_algorithm TEXT,
  access_password_iterations INTEGER,
  access_password_salt TEXT,
  access_password_hash TEXT,
  expires_at TEXT NOT NULL,
  allow_original_link INTEGER NOT NULL CHECK (allow_original_link IN (0, 1)),
  show_subscription_name INTEGER NOT NULL CHECK (show_subscription_name IN (0, 1)),
  show_groups INTEGER NOT NULL CHECK (show_groups IN (0, 1)),
  show_expiry INTEGER NOT NULL CHECK (show_expiry IN (0, 1)),
  show_node_names INTEGER NOT NULL CHECK (show_node_names IN (0, 1)),
  require_login INTEGER NOT NULL CHECK (require_login IN (0, 1)),
  max_access_count INTEGER CHECK (max_access_count IS NULL OR max_access_count > 0),
  access_count INTEGER NOT NULL CHECK (access_count >= 0),
  last_accessed_at TEXT,
  last_original_reveal_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (
      access_mode = 'none'
      AND access_password_algorithm IS NULL
      AND access_password_iterations IS NULL
      AND access_password_salt IS NULL
      AND access_password_hash IS NULL
    )
    OR (
      access_mode = 'password'
      AND access_password_algorithm = 'PBKDF2-SHA-256'
      AND access_password_iterations > 0
      AND access_password_salt IS NOT NULL
      AND access_password_hash IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX shares_token_hash ON shares(token_hash);
CREATE INDEX shares_owner_user_id ON shares(owner_user_id);
CREATE INDEX shares_subscription_id ON shares(subscription_id);
CREATE INDEX shares_status ON shares(status);
CREATE INDEX shares_expires_at ON shares(expires_at);

CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  status TEXT NOT NULL CHECK (status IN ('idle', 'success', 'failed')),
  ran_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  error_code TEXT,
  catalog_revision INTEGER CHECK (catalog_revision IS NULL OR catalog_revision >= 0)
);

CREATE INDEX cron_runs_ran_at ON cron_runs(ran_at);
CREATE INDEX cron_runs_source_id ON cron_runs(source_id);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT NOT NULL CHECK (json_type(detail) = 'object')
);

CREATE INDEX audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX audit_logs_actor_user_id ON audit_logs(actor_user_id);

CREATE TABLE migration_runs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  detail TEXT CHECK (detail IS NULL OR json_type(detail) = 'object')
);

CREATE UNIQUE INDEX migration_runs_name ON migration_runs(name);
CREATE INDEX migration_runs_status ON migration_runs(status);
