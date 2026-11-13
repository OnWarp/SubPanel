-- SubPanel APP downloads refactor (SubPanel_APP.md):
-- apps slimmed to id/name/description/enabled/sort_order + timestamps;
-- app_platforms keeps one row per (app, platform) with an https download URL,
-- an optional documentation URL and a per-platform sort order.
-- Reshaping rules: description comes from the legacy summary, falling back to
-- the legacy description; an app stays enabled only when it was enabled AND
-- public; a platform row survives only when it was enabled, resolves a download
-- URL through download_url -> official_download_url -> official_store_url and
-- that URL is https; duplicate (app, platform) rows keep the earliest one;
-- platform sort order follows the fixed platform order; apps left without a
-- surviving platform or with an empty name are disabled at the end.
-- Note: D1 enforces foreign keys, and the legacy app_platforms table cascades
-- on apps deletion, so the reshaped platform rows are staged in a table
-- without foreign keys before the apps table is rebuilt.

CREATE TABLE app_platforms_migration_stage (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos', 'android', 'ios', 'linux')),
  download_url TEXT NOT NULL,
  documentation_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO app_platforms_migration_stage (id, app_id, platform, download_url, documentation_url, sort_order, created_at, updated_at)
SELECT
  id,
  app_id,
  platform,
  url,
  NULL,
  CASE platform
    WHEN 'windows' THEN 0
    WHEN 'macos' THEN 1
    WHEN 'android' THEN 2
    WHEN 'ios' THEN 3
    ELSE 4
  END,
  created_at,
  updated_at
FROM (
  SELECT
    ranked.*,
    ROW_NUMBER() OVER (
      PARTITION BY ranked.app_id, ranked.platform
      ORDER BY ranked.created_at ASC, ranked.id ASC
    ) AS rn
  FROM (
    SELECT
      p.*,
      COALESCE(
        NULLIF(trim(p.download_url), ''),
        NULLIF(trim(p.official_download_url), ''),
        NULLIF(trim(p.official_store_url), '')
      ) AS url
    FROM app_platforms p
    WHERE p.is_enabled = 1
  ) ranked
  WHERE ranked.url IS NOT NULL AND ranked.url LIKE 'https://%'
)
WHERE rn = 1;

CREATE TABLE apps_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO apps_new (id, name, description, enabled, sort_order, created_at, updated_at)
SELECT
  id,
  name,
  CASE WHEN trim(summary) <> '' THEN summary ELSE description END,
  CASE WHEN is_enabled = 1 AND is_public = 1 THEN 1 ELSE 0 END,
  sort_order,
  created_at,
  updated_at
FROM apps;

DROP TABLE apps;

ALTER TABLE apps_new RENAME TO apps;

CREATE INDEX apps_sort_order ON apps(sort_order);
CREATE INDEX apps_enabled ON apps(enabled);

DROP TABLE app_platforms;

CREATE TABLE app_platforms (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos', 'android', 'ios', 'linux')),
  download_url TEXT NOT NULL,
  documentation_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (app_id, platform)
);

INSERT INTO app_platforms (id, app_id, platform, download_url, documentation_url, sort_order, created_at, updated_at)
SELECT id, app_id, platform, download_url, documentation_url, sort_order, created_at, updated_at
FROM app_platforms_migration_stage;

DROP TABLE app_platforms_migration_stage;

CREATE INDEX app_platforms_app_id ON app_platforms(app_id);
CREATE INDEX app_platforms_platform ON app_platforms(platform);

UPDATE apps
SET enabled = 0
WHERE trim(name) = '' OR id NOT IN (SELECT app_id FROM app_platforms);

UPDATE system_settings
SET value = json_set(
  value,
  '$.platforms',
  (
    SELECT COALESCE(json_group_array(kept.id), json('[]'))
    FROM (
      SELECT entry.value AS id
      FROM json_each(system_settings.value, '$.platforms') AS entry
      WHERE entry.value IN (SELECT id FROM app_platforms)
      ORDER BY entry.key
    ) AS kept
  )
)
WHERE key = 'apps_entity_order' AND json_type(value, '$.platforms') = 'array';
