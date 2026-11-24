-- Existing templates without a scope row are shared.
CREATE TABLE private_entitlement_templates (
  template_id TEXT NOT NULL PRIMARY KEY REFERENCES entitlement_templates(id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TRIGGER private_entitlement_scope_update BEFORE UPDATE ON private_entitlement_templates
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_SCOPE_IMMUTABLE');
END;

CREATE TRIGGER private_entitlement_scope_delete BEFORE DELETE ON private_entitlement_templates
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_SCOPE_IMMUTABLE');
END;

CREATE TABLE user_subscription_access (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash)=43 AND token_hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  token_prefix TEXT NOT NULL,
  encrypted_token TEXT CHECK (
    CASE WHEN encrypted_token IS NULL THEN 1
         WHEN json_valid(encrypted_token)=0 THEN 0
         ELSE json_type(encrypted_token)='object'
           AND json_type(encrypted_token,'$.version') IS 'integer'
           AND json_extract(encrypted_token,'$.version') IS 1
           AND json_extract(encrypted_token,'$.algorithm') IS 'AES-GCM'
           AND json_type(encrypted_token,'$.iv') IS 'text'
           AND json_type(encrypted_token,'$.ciphertext') IS 'text' END
  ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  default_client TEXT NOT NULL DEFAULT 'generic' CHECK (default_client IN (
    'mihomo','singbox','surge','loon','quantumultx','v2rayn','nekobox','shadowrocket','generic'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_template_bindings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL REFERENCES entitlement_templates(id) ON DELETE RESTRICT,
  starts_at INTEGER NOT NULL CHECK (
    typeof(starts_at)='integer' AND starts_at BETWEEN -8640000000000000 AND 8640000000000000
  ),
  expires_at INTEGER CHECK (
    expires_at IS NULL OR (typeof(expires_at)='integer'
      AND expires_at BETWEEN -8640000000000000 AND 8640000000000000 AND expires_at>starts_at)
  ),
  status TEXT NOT NULL CHECK (status IN ('active','paused','revoked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,template_id)
);

CREATE INDEX binding_template_users ON user_template_bindings(template_id,user_id);
CREATE INDEX binding_user_status ON user_template_bindings(user_id,status,expires_at);

CREATE TRIGGER binding_private_owner_insert
BEFORE INSERT ON user_template_bindings
WHEN EXISTS (
  SELECT 1 FROM private_entitlement_templates t WHERE t.template_id=NEW.template_id
    AND t.owner_user_id IS NOT NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_OWNER_MISMATCH');
END;

CREATE TRIGGER binding_identity_immutable
BEFORE UPDATE OF user_id, template_id ON user_template_bindings
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.template_id IS NOT OLD.template_id
BEGIN
  SELECT RAISE(ABORT, 'BINDING_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER redemption_batch_shared_insert
BEFORE INSERT ON redemption_batches
WHEN EXISTS (
  SELECT 1 FROM entitlement_template_versions v JOIN private_entitlement_templates t ON t.template_id=v.template_id
  WHERE v.id=NEW.template_version_id
)
BEGIN
  SELECT RAISE(ABORT, 'REDEMPTION_PRIVATE_TEMPLATE');
END;

CREATE TRIGGER redemption_batch_shared_update
BEFORE UPDATE OF template_version_id ON redemption_batches
WHEN EXISTS (
  SELECT 1 FROM entitlement_template_versions v JOIN private_entitlement_templates t ON t.template_id=v.template_id
  WHERE v.id=NEW.template_version_id
)
BEGIN
  SELECT RAISE(ABORT, 'REDEMPTION_PRIVATE_TEMPLATE');
END;

CREATE TRIGGER private_entitlement_scope_insert BEFORE INSERT ON private_entitlement_templates
WHEN EXISTS (SELECT 1 FROM entitlement_templates WHERE id=NEW.template_id AND allow_redemption=1)
  OR EXISTS (SELECT 1 FROM entitlement_template_versions WHERE template_id=NEW.template_id)
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_SCOPE_IMMUTABLE');
END;

CREATE TRIGGER private_entitlement_redemption_policy BEFORE UPDATE OF allow_redemption ON entitlement_templates
WHEN NEW.allow_redemption=1 AND EXISTS (SELECT 1 FROM private_entitlement_templates WHERE template_id=NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'REDEMPTION_PRIVATE_TEMPLATE');
END;

CREATE TRIGGER private_entitlement_legacy_origin BEFORE INSERT ON subscription_template_origins
WHEN EXISTS (
  SELECT 1 FROM entitlement_template_versions v JOIN private_entitlement_templates t ON t.template_id=v.template_id
  WHERE v.id=NEW.version_id
)
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_PRIVATE_LEGACY_ORIGIN');
END;

CREATE TRIGGER unified_entitlement_archive BEFORE UPDATE OF status ON entitlement_templates
WHEN NEW.status='archived' AND OLD.status<>'archived' AND (
  EXISTS (SELECT 1 FROM user_template_bindings b WHERE b.template_id=NEW.id AND b.status<>'revoked'
    AND (b.expires_at IS NULL OR b.expires_at>unixepoch('subsec')*1000))

)
BEGIN
  SELECT RAISE(ABORT, 'ENTITLEMENT_IN_USE');
END;

CREATE TABLE user_binding_requests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  changes_json TEXT NOT NULL CHECK (json_valid(changes_json)),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
