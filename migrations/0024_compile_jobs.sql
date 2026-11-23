CREATE TABLE compile_jobs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  plan_id TEXT,
  group_id TEXT,
  cursor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  total INTEGER NOT NULL,
  compiled INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_failure_id TEXT,
  error_code TEXT,
  lease TEXT,
  lease_until INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE compile_job_items (
  job_id TEXT NOT NULL REFERENCES compile_jobs(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  PRIMARY KEY (job_id, subscription_id)
) WITHOUT ROWID;

CREATE INDEX compile_jobs_created ON compile_jobs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS subscription_groups_compile_group ON subscription_groups(group_id, subscription_id);
CREATE INDEX IF NOT EXISTS public_fetch_rate_expiry ON rate_limits(expires_at)
  WHERE bucket IN ('subscription_address', 'subscription_subscription');

CREATE TRIGGER compile_job_created AFTER INSERT ON compile_jobs BEGIN
  INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.actor_user_id, 'compile_job.created', 'compile_job', NEW.id,
    json_object('platform', NEW.platform, 'planId', NEW.plan_id, 'groupId', NEW.group_id, 'total', NEW.total), NEW.created_at);
END;

CREATE TRIGGER compile_job_progress AFTER UPDATE ON compile_jobs
WHEN OLD.cursor <> NEW.cursor OR OLD.status <> NEW.status BEGIN
  INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.actor_user_id, 'compile_job.' || NEW.status, 'compile_job', NEW.id,
    json_object('compiled', NEW.compiled, 'cacheHits', NEW.cache_hits, 'skipped', NEW.skipped,
      'failures', NEW.failures, 'durationMs', NEW.run_ms, 'errorCode', NEW.error_code), NEW.updated_at);
END;

CREATE TRIGGER compile_job_cleanup AFTER UPDATE OF status ON compile_jobs
WHEN NEW.status IN ('completed','failed','cancelled') BEGIN
  DELETE FROM compile_job_items WHERE job_id=NEW.id;
END;
