-- Batch 6: registration & invitation codes.
-- Generic invitation codes: 'multi' = one code usable by many people up to
-- max_uses (NULL = unlimited); 'single' = batch-generated one-time codes.
-- This migration only adds the two code tables: email_verifications was
-- already rebuilt by 0002 (nullable user_id, purpose column),
-- allowed_email_domains exists since 0001, and the users unique indexes
-- (users_username, users_email_normalized) also date from 0001.
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
