CREATE TABLE subscriptions_next (
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
  CHECK (starts_at IS NULL OR expires_at IS NULL OR starts_at <= expires_at)
);


INSERT INTO subscriptions_next SELECT * FROM subscriptions;
CREATE TABLE subscription_groups_saved AS SELECT * FROM subscription_groups;
DROP TABLE subscription_groups;
DROP TABLE subscriptions;
ALTER TABLE subscriptions_next RENAME TO subscriptions;
CREATE TABLE subscription_groups (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (subscription_id, group_id)
);

CREATE UNIQUE INDEX subscription_groups_position ON subscription_groups(subscription_id, position);
CREATE INDEX subscription_groups_group_id ON subscription_groups(group_id);

INSERT INTO subscription_groups SELECT * FROM subscription_groups_saved;
DROP TABLE subscription_groups_saved;

CREATE UNIQUE INDEX subscriptions_token_hash ON subscriptions(token_hash);
CREATE INDEX subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX subscriptions_enabled ON subscriptions(enabled);
