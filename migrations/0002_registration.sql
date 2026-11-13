-- Batch 6: registration & invitation codes.
-- Generic invitation codes: 'multi' = one code usable by many people up to
-- max_uses (NULL = unlimited); 'single' = batch-generated one-time codes.
CREATE TABLE invite_codes (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('multi', 'single')),
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at TEXT,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX invite_codes_created_at ON invite_codes(created_at);

CREATE TABLE invite_code_redemptions (
  id INTEGER PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES invite_codes(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  redeemed_at TEXT NOT NULL
);

CREATE INDEX invite_code_redemptions_code_id ON invite_code_redemptions(code_id);
CREATE INDEX invite_code_redemptions_user_id ON invite_code_redemptions(user_id);

-- Registration codes have no user yet, so email_verifications.user_id must be
-- nullable, and rows need a purpose discriminator (batch 4 binding rows keep
-- the 'bind' default). Rebuild the table to relax the column.
CREATE TABLE email_verifications_new (
  id INTEGER PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'bind',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO email_verifications_new (id, user_id, email, email_normalized, token_hash, expires_at, consumed_at, created_at)
  SELECT id, user_id, email, email_normalized, token_hash, expires_at, consumed_at, created_at FROM email_verifications;

DROP TABLE email_verifications;
ALTER TABLE email_verifications_new RENAME TO email_verifications;

CREATE UNIQUE INDEX email_verifications_token_hash ON email_verifications(token_hash);
CREATE INDEX email_verifications_user_id ON email_verifications(user_id);
CREATE INDEX email_verifications_email_normalized ON email_verifications(email_normalized);

-- Registration relies on database-level uniqueness, not snapshot checks.
CREATE UNIQUE INDEX users_username_unique ON users(username);
CREATE UNIQUE INDEX users_email_normalized_unique ON users(email_normalized) WHERE email_normalized IS NOT NULL;
