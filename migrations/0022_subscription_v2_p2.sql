CREATE TABLE IF NOT EXISTS entitlement_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'archived')),
  allow_redemption INTEGER NOT NULL CHECK (allow_redemption IN (0, 1)),
  revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlement_template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES entitlement_templates(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (template_id, version_no)
);

CREATE TABLE IF NOT EXISTS subscription_template_origins (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES entitlement_template_versions(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_subscription_template_origins_version ON subscription_template_origins(version_id);

CREATE TABLE IF NOT EXISTS subscription_nodes (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (subscription_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_subscription_nodes_node ON subscription_nodes(node_id);

CREATE TRIGGER IF NOT EXISTS entitlement_version_no_update
BEFORE UPDATE ON entitlement_template_versions
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_VERSION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS entitlement_version_no_delete
BEFORE DELETE ON entitlement_template_versions
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_VERSION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS entitlement_version_groups_exist
BEFORE INSERT ON entitlement_template_versions
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.config_json, '$.groupIds') AS selected
  WHERE NOT EXISTS (SELECT 1 FROM groups WHERE id = selected.value)
)
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_GROUP_MISSING');
END;

CREATE TRIGGER IF NOT EXISTS entitlement_origin_can_issue
BEFORE INSERT ON subscription_template_origins
WHEN NOT EXISTS (
  SELECT 1 FROM entitlement_template_versions v
  JOIN entitlement_templates t ON t.id = v.template_id
  WHERE v.id = NEW.version_id AND t.status = 'enabled'
    AND v.version_no = (SELECT max(version_no) FROM entitlement_template_versions WHERE template_id = t.id)
)
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_VERSION_UNAVAILABLE');
END;


CREATE TRIGGER IF NOT EXISTS entitlement_group_in_use
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

CREATE TRIGGER IF NOT EXISTS subscription_node_enabled
BEFORE INSERT ON subscription_nodes
WHEN NOT EXISTS (SELECT 1 FROM nodes WHERE id = NEW.node_id AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'SUBSCRIPTION_NODE_UNAVAILABLE');
END;

CREATE TRIGGER IF NOT EXISTS entitlement_version_nodes_exist
BEFORE INSERT ON entitlement_template_versions
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.config_json, '$.nodeIds') AS selected
  WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE id = selected.value AND enabled = 1)
)
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_NODE_MISSING');
END;
