-- Missing metadata means legacy, including rows written by a rolled-back Worker.
CREATE TABLE IF NOT EXISTS subscription_creation (
  subscription_id TEXT UNIQUE REFERENCES subscriptions(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'legacy')),
  request_key_hash TEXT UNIQUE,
  request_fingerprint TEXT,
  CHECK ((request_key_hash IS NULL) = (request_fingerprint IS NULL))
);

-- Record the legacy provenance without updating the original subscriptions.
INSERT INTO subscription_creation (subscription_id, source_type)
SELECT id, 'legacy' FROM subscriptions WHERE true
ON CONFLICT(subscription_id) DO NOTHING;
