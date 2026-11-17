ALTER TABLE audit_logs RENAME TO audit_logs_legacy;
CREATE TABLE audit_logs (
 id TEXT PRIMARY KEY, actor_user_id TEXT, action TEXT NOT NULL,
 target_type TEXT NOT NULL, target_id TEXT, detail TEXT NOT NULL CHECK(json_valid(detail)), created_at TEXT NOT NULL
);
INSERT INTO audit_logs SELECT CAST(id AS TEXT),actor_user_id,action,entity_type,entity_id,detail,created_at FROM audit_logs_legacy;
DROP TABLE audit_logs_legacy;
CREATE INDEX audit_logs_created ON audit_logs(created_at DESC, id);
CREATE INDEX audit_logs_actor_action ON audit_logs(actor_user_id, action, created_at DESC);
CREATE TABLE mail_templates (key TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE mail_broadcasts (
 id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, target TEXT NOT NULL CHECK(target IN ('all','active','expiring')),
 status TEXT NOT NULL CHECK(status IN ('sending','sent','partial','failed')), total INTEGER NOT NULL DEFAULT 0,
 sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT
);
ALTER TABLE user_entitlements ADD COLUMN last_reminded_at INTEGER;
INSERT INTO system_settings(key,value,updated_at) VALUES('reminder_days','3',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
