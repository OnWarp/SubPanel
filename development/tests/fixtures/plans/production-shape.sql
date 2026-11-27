-- Synthetic data only. Apply after the local PR6 contraction rehearsal.
INSERT INTO users (id, username, role, enabled, password_algorithm, password_iterations,
  password_salt, password_hash, session_version, created_at, updated_at)
VALUES ('usr_1','admin','admin',1,'PBKDF2-SHA-256',1,'fixture','fixture',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
  ('usr_2','member','user',1,'PBKDF2-SHA-256',1,'fixture','fixture',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');

WITH RECURSIVE ids(i) AS (VALUES (1) UNION ALL SELECT i+1 FROM ids WHERE i<8)
INSERT INTO groups (id, name, created_at, updated_at)
SELECT 'grp_' || i, 'Group ' || i, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM ids;

INSERT INTO nodes (id, protocol, display_name, server, port, credentials, extensions, fingerprint,
  source_ids, enabled, retained, sort_order, created_at, updated_at)
VALUES ('node_1','http','Direct node','example.invalid',80,'{}','{}','fixture','[]',1,0,0,
  '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');

WITH RECURSIVE ids(i) AS (VALUES (1) UNION ALL SELECT i+1 FROM ids WHERE i<6)
INSERT INTO entitlement_templates (id,name,description,status,allow_redemption,revision,created_by,created_at,updated_at)
SELECT 'template_' || i,'Template ' || i,'Description ' || i,
  CASE WHEN i=6 THEN 'disabled' ELSE 'enabled' END,i=1,3,'usr_1','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z'
FROM ids;

INSERT INTO private_entitlement_templates (template_id, owner_user_id)
SELECT id, 'usr_2' FROM entitlement_templates WHERE id IN ('template_3','template_4','template_5','template_6');

WITH RECURSIVE ids(i) AS (VALUES (1) UNION ALL SELECT i+1 FROM ids WHERE i<6)
INSERT INTO entitlement_template_versions (id,template_id,version_no,schema_version,config_json,created_by,created_at)
SELECT 'version_' || i, 'template_' || i, 1, 1,
  json_object('duration', json_object('value', i, 'unit', CASE WHEN i<=2 THEN 'month' ELSE 'day' END),
    'quotaBytes', NULL, 'resetPolicy', 'none', 'limits', json_object('speedLimitMbps', 0),
    'groupIds', json_array('grp_' || i),
    'nodeIds', json(CASE WHEN i=3 THEN '["node_1"]' ELSE '[]' END)),
  'usr_1','2026-01-01T00:00:00Z'
FROM ids;

INSERT INTO plans (id,name,description,duration_days,created_at,updated_at)
VALUES ('legacy_1','Legacy plan','Legacy description',7,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
INSERT INTO plan_groups VALUES ('legacy_1','grp_8',0);

INSERT INTO user_template_bindings (user_id,template_id,starts_at,expires_at,status,revision,created_at,updated_at)
VALUES ('usr_2','template_3',1700000000123,1800000000555,'active',4,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z'),
  ('usr_2','template_4',1700000001000,NULL,'active',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
  ('usr_2','template_5',1700000002000,1700000003000,'revoked',2,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z'),
  ('usr_2','template_6',1700000004000,1700000005000,'revoked',2,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');

INSERT INTO user_subscription_access (user_id, token_hash, token_prefix, encrypted_token, enabled, created_at, updated_at)
VALUES ('usr_2', replace(printf('%43s',''),' ','A'),'fixture',
  '{"version":1,"algorithm":"AES-GCM","iv":"fixture","ciphertext":"fixture"}',
  1,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');

INSERT INTO redemption_batches (id,name,template_version_id,template_name,quantity,max_uses,redeem_deadline,
  note,created_by,created_at,request_key)
VALUES ('batch_1','Batch','version_1','Template 1',1,1,1790000000000,'Fixture',
  'usr_1','2026-01-01T00:00:00Z','batch-request');
INSERT INTO redemption_codes (id,batch_id,digest_key_version,code_digest,tail,max_uses,used_count)
VALUES ('code_1','batch_1','v1','fixture-digest','ABCD',1,1);
INSERT INTO redemption_records (id,code_id,user_id,issued_subscription_id,subscription_name,expires_at,redeemed_at,idempotency_key,replay_verifier)
VALUES ('receipt_1','code_1','usr_2','sub_99','Old issue',1750000000000,'2026-01-01T00:00:00Z','legacy-request','fixture');

WITH RECURSIVE ids(i) AS (VALUES (1) UNION ALL SELECT i+1 FROM ids WHERE i<4)
INSERT INTO legacy_subscriptions_archive (id,user_id,name,token_hash,token_prefix,encrypted_token,enabled,default_client,
  revision,created_at,updated_at)
SELECT 'sub_' || i,'usr_2','Archive ' || i,'archive-hash-' || i,'fixture','{}',0,'generic',1,
  '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM ids;

-- Links have no live subscription; the contracted test schema can retain
-- references to archived rows while keeping foreign_key_check clean.
INSERT INTO subscription_groups (subscription_id,group_id,position)
VALUES ('sub_1','grp_1',0),('sub_1','grp_2',1),('sub_1','grp_3',2),
  ('sub_2','grp_1',0),('sub_2','grp_2',1),('sub_3','grp_1',0),('sub_3','grp_2',1),
  ('sub_4','grp_4',0),('sub_4','grp_5',1);
