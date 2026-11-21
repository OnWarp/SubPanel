ALTER TABLE sources ADD COLUMN sync_metadata TEXT;
ALTER TABLE nodes ADD COLUMN source_metadata TEXT;
ALTER TABLE groups ADD COLUMN match_rules TEXT;

-- Retain history after a source is deleted. Source IDs are never recycled.
CREATE TABLE catalog_sync_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'cancelled')),
  details TEXT NOT NULL
);
CREATE INDEX catalog_sync_runs_source_started ON catalog_sync_runs(source_id, started_at DESC);

CREATE TABLE catalog_sync_leases (
  slot INTEGER PRIMARY KEY CHECK (slot IN (1, 2)),
  source_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1))
);
