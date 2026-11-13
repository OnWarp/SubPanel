CREATE TABLE shares_next (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL,
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

INSERT INTO shares_next (
  id, schema_version, owner_user_id, subscription_id, token_hash, token_prefix, token_encrypted,
  remark, status, access_mode, access_password_algorithm, access_password_iterations,
  access_password_salt, access_password_hash, expires_at, allow_original_link,
  show_subscription_name, show_groups, show_expiry, show_node_names, require_login,
  max_access_count, access_count, last_accessed_at, last_original_reveal_at, created_at, updated_at
)
SELECT
  id, schema_version, owner_user_id, subscription_id, token_hash, token_prefix, token_encrypted,
  remark, status, access_mode, access_password_algorithm, access_password_iterations,
  access_password_salt, access_password_hash, expires_at, allow_original_link,
  show_subscription_name, show_groups, show_expiry, show_node_names, require_login,
  max_access_count, access_count, last_accessed_at, last_original_reveal_at, created_at, updated_at
FROM shares;

DROP TABLE shares;

ALTER TABLE shares_next RENAME TO shares;

CREATE UNIQUE INDEX shares_token_hash ON shares(token_hash);
CREATE INDEX shares_owner_user_id ON shares(owner_user_id);
CREATE INDEX shares_subscription_id ON shares(subscription_id);
CREATE INDEX shares_status ON shares(status);
CREATE INDEX shares_expires_at ON shares(expires_at);
