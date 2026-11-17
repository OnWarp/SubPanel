CREATE TABLE subscription_templates (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, draft TEXT NOT NULL,
 published_id TEXT, archived INTEGER NOT NULL DEFAULT 0,
 source_url TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE subscription_template_versions (
 id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES subscription_templates(id),
 yaml TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE subscription_template_default (
 id INTEGER PRIMARY KEY CHECK(id = 1), template_id TEXT REFERENCES subscription_templates(id)
);
INSERT INTO subscription_template_default(id,template_id) VALUES(1,NULL);
CREATE TABLE subscription_template_bindings (
 subscription_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('inherit','specific','base')),
 template_id TEXT REFERENCES subscription_templates(id),
 CHECK((mode = 'specific' AND template_id IS NOT NULL) OR (mode != 'specific' AND template_id IS NULL))
);
