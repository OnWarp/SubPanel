-- Mihomo retains its original draft, publication pointer and revisions.
-- Shared identifiers allow additional platform versions to attach to the same profile.
CREATE TABLE conversion_profiles (
  id TEXT PRIMARY KEY,
  legacy_template_id TEXT UNIQUE REFERENCES subscription_templates(id) ON DELETE CASCADE,
  name TEXT,
  created_at TEXT,
  CHECK ((legacy_template_id IS NULL AND name IS NOT NULL AND created_at IS NOT NULL)
    OR (id = legacy_template_id AND name IS NULL AND created_at IS NULL))
);

CREATE TABLE conversion_profile_versions (
  profile_id TEXT NOT NULL REFERENCES conversion_profiles(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('mihomo','singbox','surge','loon','quantumultx')),
  legacy_version_id TEXT UNIQUE REFERENCES subscription_template_versions(id) ON DELETE CASCADE,
  target_version TEXT,
  source_json TEXT CHECK (source_json IS NULL OR json_valid(source_json)),
  compiled_json TEXT CHECK (compiled_json IS NULL OR json_valid(compiled_json)),
  diagnostics_json TEXT CHECK (diagnostics_json IS NULL OR json_valid(diagnostics_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, platform, id),
  CHECK ((platform = 'mihomo' AND legacy_version_id IS NOT NULL AND id = legacy_version_id
    AND source_json IS NULL AND compiled_json IS NULL)
    OR (platform <> 'mihomo' AND legacy_version_id IS NULL AND target_version IS NOT NULL AND source_json IS NOT NULL)),
  CHECK (platform <> 'singbox' OR compiled_json IS NULL OR (
    json_type(compiled_json, '$.outbounds') IS 'array'
    AND json_type(compiled_json, '$.route') IS 'object'
    AND json_type(compiled_json, '$.dns') IS 'object'
    AND (json_type(compiled_json, '$.route.rule_set') IS NULL
      OR json_type(compiled_json, '$.route.rule_set') IS 'array')
  ))
);

-- The compatibility API writes Mihomo bindings to the original table.
-- This table stores platform-specific overrides as those platforms gain compilers.
CREATE TABLE conversion_bindings (
  subscription_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('singbox','surge','loon','quantumultx')),
  mode TEXT NOT NULL CHECK (mode IN ('inherit','specific','base')),
  profile_id TEXT REFERENCES conversion_profiles(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, platform),
  CHECK ((mode = 'specific') = (profile_id IS NOT NULL))
);

INSERT INTO conversion_profiles(id, legacy_template_id)
  SELECT id, id FROM subscription_templates;
INSERT INTO conversion_profile_versions(profile_id, id, platform, legacy_version_id, created_at)
  SELECT template_id, id, 'mihomo', id, created_at FROM subscription_template_versions;

CREATE TRIGGER conversion_link_template AFTER INSERT ON subscription_templates BEGIN
  INSERT INTO conversion_profiles(id, legacy_template_id) VALUES (NEW.id, NEW.id);
END;
CREATE TRIGGER conversion_link_version AFTER INSERT ON subscription_template_versions BEGIN
  INSERT INTO conversion_profile_versions(profile_id, id, platform, legacy_version_id, created_at)
    VALUES (NEW.template_id, NEW.id, 'mihomo', NEW.id, NEW.created_at);
END;

CREATE VIEW conversion_profile_catalog AS
  SELECT p.id, COALESCE(l.name,p.name) AS name, COALESCE(l.created_at,p.created_at) AS created_at,
         l.published_id AS mihomo_published_id, l.archived AS mihomo_archived
  FROM conversion_profiles p LEFT JOIN subscription_templates l ON l.id = p.legacy_template_id;

CREATE VIEW conversion_profile_outputs AS
  SELECT v.profile_id, v.id, v.platform, v.target_version, v.source_json, v.compiled_json,
         v.diagnostics_json, l.yaml AS legacy_yaml, l.normalized_json AS mihomo_policy, v.created_at
  FROM conversion_profile_versions v LEFT JOIN subscription_template_versions l ON l.id = v.legacy_version_id;

CREATE VIEW conversion_effective_bindings AS
  SELECT subscription_id, 'mihomo' AS platform, mode, template_id AS profile_id, revision, updated_at
  FROM subscription_template_bindings
  UNION ALL
  SELECT subscription_id, platform, mode, profile_id, revision, updated_at FROM conversion_bindings;

CREATE TABLE conversion_rule_sources (
  url TEXT NOT NULL,
  behavior TEXT NOT NULL CHECK (behavior IN ('domain','ipcidr','classical')),
  format TEXT NOT NULL CHECK (format IN ('yaml','text')),
  version TEXT,
  payload TEXT,
  last_success_at TEXT,
  etag TEXT,
  last_modified TEXT,
  error_code TEXT,
  attempt_id TEXT NOT NULL,
  PRIMARY KEY (url, behavior, format)
);


CREATE TABLE conversion_local_rule_sets (
  name TEXT PRIMARY KEY,
  rules_json TEXT NOT NULL CHECK (json_type(rules_json) IS 'array'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
);
