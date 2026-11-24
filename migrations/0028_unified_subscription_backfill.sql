CREATE TABLE unified_subscription_mappings (
  legacy_subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL UNIQUE REFERENCES entitlement_templates(id) ON DELETE RESTRICT,
  source_revision INTEGER NOT NULL,
  source_token_hash TEXT NOT NULL,
  original_node_ids TEXT NOT NULL CHECK (json_type(original_node_ids)='array'),
  status TEXT NOT NULL CHECK (status='backfilled'),
  created_at TEXT NOT NULL
);
CREATE INDEX unified_subscription_mapping_user ON unified_subscription_mappings(user_id);

CREATE TABLE unified_subscription_checkpoints (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_snapshot TEXT NOT NULL CHECK (json_type(source_snapshot)='array'),
  created_at TEXT NOT NULL
);

-- A stale preview must abort the entire D1 batch before any shadow write.
CREATE TRIGGER unified_subscription_checkpoint_guard BEFORE INSERT ON unified_subscription_checkpoints
WHEN NEW.source_snapshot IS NOT (
  SELECT json_group_array(json_array(id,revision)) FROM (
    SELECT id,revision FROM subscriptions WHERE user_id=NEW.user_id ORDER BY id
  )
)
OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND enabled=1 AND deleted_at IS NULL)
OR EXISTS (SELECT 1 FROM user_template_bindings WHERE user_id=NEW.user_id)
OR EXISTS (SELECT 1 FROM user_subscription_access WHERE user_id=NEW.user_id AND enabled=0)
OR EXISTS (SELECT 1 FROM system_settings WHERE key='unified_subscription_cutover_at')
BEGIN
  SELECT RAISE(ABORT, 'UNIFIED_MIGRATION_SOURCE_CHANGED');
END;
