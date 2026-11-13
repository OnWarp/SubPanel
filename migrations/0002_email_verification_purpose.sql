-- Batch 5: email_verifications gains a purpose dimension and register
-- verifications have no account yet, so user_id becomes nullable.
-- Existing rows are batch-4 email-binding codes, hence the 'bind_email'
-- default when copying them over.
CREATE TABLE email_verifications_v2 (
  id INTEGER PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'bind_email'
    CHECK (purpose IN ('register', 'bind_email', 'change_email', 'reset_password')),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO email_verifications_v2 (
  id, user_id, email, email_normalized, token_hash, expires_at, consumed_at, created_at
)
SELECT id, user_id, email, email_normalized, token_hash, expires_at, consumed_at, created_at
FROM email_verifications;

DROP TABLE email_verifications;

ALTER TABLE email_verifications_v2 RENAME TO email_verifications;

CREATE UNIQUE INDEX email_verifications_token_hash ON email_verifications(token_hash);
CREATE INDEX email_verifications_user_id ON email_verifications(user_id);
CREATE INDEX email_verifications_email_normalized ON email_verifications(email_normalized);
CREATE INDEX email_verifications_email_purpose ON email_verifications(email_normalized, purpose);
