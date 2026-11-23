ALTER TABLE compile_jobs ADD COLUMN operation_json TEXT CHECK (operation_json IS NULL OR json_type(operation_json) = 'object');
ALTER TABLE compile_job_items ADD COLUMN reviewed_state TEXT;
ALTER TABLE compile_job_items ADD COLUMN outcome TEXT CHECK (outcome IN ('applied','failed'));
ALTER TABLE compile_job_items ADD COLUMN error_code TEXT;
ALTER TABLE compile_job_items ADD COLUMN copy_id TEXT;

DROP TRIGGER compile_job_cleanup;
CREATE TRIGGER compile_job_cleanup AFTER UPDATE OF status ON compile_jobs
WHEN NEW.operation_json IS NULL AND NEW.status IN ('completed','failed','cancelled') BEGIN
  DELETE FROM compile_job_items WHERE job_id=NEW.id;
END;

CREATE TRIGGER subscription_batch_item_audit AFTER UPDATE OF outcome ON compile_job_items
WHEN OLD.outcome IS NULL AND NEW.outcome IS NOT NULL BEGIN
  INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
  SELECT lower(hex(randomblob(16))), actor_user_id,
    'subscription_batch.' || json_extract(operation_json,'$.input.action'), 'subscriptions', NEW.subscription_id,
    json_object('jobId', id, 'outcome', NEW.outcome, 'errorCode', NEW.error_code,
      'copyId', NEW.copy_id, 'planId', json_extract(operation_json,'$.input.planId'),
      'binding', json_extract(operation_json,'$.input.templateBinding')),
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM compile_jobs WHERE id=NEW.job_id;
END;

CREATE TABLE conversion_rule_version_snapshots (
  version_id TEXT PRIMARY KEY REFERENCES subscription_template_versions(id) ON DELETE CASCADE,
  versions_json TEXT NOT NULL CHECK (json_type(versions_json) = 'array')
);
