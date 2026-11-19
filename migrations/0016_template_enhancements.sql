-- Migration 0016: Template Enhancements for P1
-- Adds revision/draft_hash/source metadata to subscription_templates
-- Adds sequence/normalized_json/content_hash/validator_version/created_by to subscription_template_versions
-- Adds revision/updated_at to subscription_template_default and subscription_template_bindings

-- subscription_templates: add revision, draft_hash, source metadata, created_at
ALTER TABLE subscription_templates ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subscription_templates ADD COLUMN draft_hash TEXT;
ALTER TABLE subscription_templates ADD COLUMN source_fetched_at TEXT;
ALTER TABLE subscription_templates ADD COLUMN source_etag TEXT;
ALTER TABLE subscription_templates ADD COLUMN source_last_modified TEXT;
ALTER TABLE subscription_templates ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'));

-- Backfill created_at and revision for existing rows
UPDATE subscription_templates SET created_at = updated_at WHERE created_at IS NULL OR created_at = '';
UPDATE subscription_templates SET revision = 1 WHERE revision IS NULL;

-- subscription_template_versions: add sequence, normalized_json, content_hash, validator_version, created_by
ALTER TABLE subscription_template_versions ADD COLUMN sequence INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subscription_template_versions ADD COLUMN normalized_json TEXT;
ALTER TABLE subscription_template_versions ADD COLUMN content_hash TEXT;
ALTER TABLE subscription_template_versions ADD COLUMN validator_version TEXT;
ALTER TABLE subscription_template_versions ADD COLUMN created_by TEXT;

-- Backfill sequence for existing versions per template
CREATE TEMP TABLE version_seq AS
SELECT id, ROW_NUMBER() OVER (PARTITION BY template_id ORDER BY created_at) AS seq
FROM subscription_template_versions;
UPDATE subscription_template_versions
SET sequence = (SELECT seq FROM version_seq WHERE version_seq.id = subscription_template_versions.id);
DROP TABLE version_seq;

-- subscription_template_default: add revision, updated_at
ALTER TABLE subscription_template_default ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subscription_template_default ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

-- subscription_template_bindings: add revision, updated_at
ALTER TABLE subscription_template_bindings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subscription_template_bindings ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

-- Indexes for performance
CREATE INDEX idx_subscription_template_versions_template_id_sequence ON subscription_template_versions(template_id, sequence);
CREATE INDEX idx_subscription_templates_archived_updated ON subscription_templates(archived, updated_at DESC);
CREATE INDEX idx_subscription_template_bindings_template_id ON subscription_template_bindings(template_id);