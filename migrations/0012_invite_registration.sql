-- Retain old D1 invitation token hashes as ordinary single-use registration
-- qualifications. Username/user_id reservations are intentionally ignored.
INSERT OR IGNORE INTO invite_codes
  (id, token_hash, token_prefix, type, max_uses, used_count, expires_at, disabled, created_at)
SELECT i.id, i.id, 'legacy', 'single', 1,
  CASE WHEN EXISTS (SELECT 1 FROM invitation_redemptions r WHERE r.invitation_id = i.id) THEN 1 ELSE 0 END,
  i.expires_at, 0, i.created_at
FROM invitations i;
