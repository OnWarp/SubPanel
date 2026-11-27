CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'failed')),
  verified_at TEXT,
  last_checked_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('panel', 'subscription')),
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (domain_id, purpose),
  CHECK (is_primary = 0 OR enabled = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_primary_per_purpose
  ON domain_bindings(purpose) WHERE is_primary = 1;

CREATE TABLE IF NOT EXISTS domain_verification_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS domain_challenges_by_domain
  ON domain_verification_challenges(domain_id, consumed_at);

WITH legacy AS (
  SELECT * FROM panel_domains
  UNION ALL
  SELECT * FROM subscription_domains
), merged AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY hostname ORDER BY last_check_at DESC, updated_at DESC, id
    ) AS latest,
    MAX(CASE verification_status WHEN 'verified' THEN 2 WHEN 'failed' THEN 1 ELSE 0 END)
      OVER (PARTITION BY hostname) AS best_status,
    MAX(verified_at) OVER (PARTITION BY hostname) AS latest_verified_at,
    MIN(created_at) OVER (PARTITION BY hostname) AS first_created_at,
    MAX(updated_at) OVER (PARTITION BY hostname) AS latest_updated_at
  FROM legacy
)
INSERT OR IGNORE INTO domains
  (id, hostname, verification_status, verified_at, last_checked_at, last_error_code, created_at, updated_at)
SELECT 'legacy:' || hostname, hostname,
  CASE best_status WHEN 2 THEN 'verified' WHEN 1 THEN 'failed' ELSE 'pending' END,
  latest_verified_at, last_check_at, last_check_error, first_created_at, latest_updated_at
FROM merged WHERE latest = 1
  AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'domain_bindings_backfilled');

WITH legacy AS (
  SELECT 'panel' AS purpose, * FROM panel_domains
  UNION ALL
  SELECT 'subscription' AS purpose, * FROM subscription_domains
)
INSERT OR IGNORE INTO domain_bindings
  (id, domain_id, purpose, note, enabled, is_primary, created_at, updated_at)
SELECT legacy.id, domains.id, purpose, note, enabled,
  CASE WHEN enabled = 1 AND json_quote(legacy.id) =
    (SELECT CASE WHEN json_valid(value) THEN json_quote(json_extract(value, '$')) END
     FROM system_settings WHERE key = 'primary_' || purpose || '_domain_id')
    THEN 1 ELSE 0 END,
  legacy.created_at, legacy.updated_at
FROM legacy JOIN domains ON domains.hostname = legacy.hostname
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'domain_bindings_backfilled');

INSERT OR IGNORE INTO system_settings (key, value, updated_at)
VALUES ('domain_bindings_backfilled', 'true', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
