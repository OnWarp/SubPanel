-- Before cutover only. Reserved IDs identify imported rows.
DELETE FROM redemptions WHERE id GLOB 'migration:legacy-receipt:*' OR id GLOB 'migration:binding-receipt:*';
DELETE FROM redeem_codes WHERE id GLOB 'migration:code:*';
DELETE FROM subscription_tokens WHERE id GLOB 'migration:access:*';
DELETE FROM user_plans WHERE source = 'migration' AND id GLOB 'migration:binding:*';
DELETE FROM plan_definitions
WHERE (source_type = 'template' AND id = 'migration:template:' || source_id)
   OR (source_type = 'legacy_plan' AND id = 'migration:legacy-plan:' || source_id);
